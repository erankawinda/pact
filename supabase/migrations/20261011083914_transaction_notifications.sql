-- Device opt-in Web Push. Only committed financial activity can create alerts.
-- Endpoints, keys and delivery history are never exposed through household snapshots.
begin;

create table private.notification_preferences (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 expenses boolean not null default true,
 refunds boolean not null default true,
 repayments boolean not null default true,
 tone text not null default 'friendly' check(tone in ('friendly','brief'))
);
create table private.push_subscriptions (
 id uuid primary key,
 user_id uuid not null references public.profiles(id) on delete cascade,
 session_id uuid not null,
 endpoint text not null unique,
 p256dh text not null,
 auth text not null,
 binding uuid not null,
 enabled_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 revoked_at timestamptz
);
create index push_subscriptions_owner on private.push_subscriptions(user_id) where revoked_at is null;
create table private.notification_outbox (
 id uuid primary key default gen_random_uuid(),
 activity_id uuid references public.activity_log(id) on delete cascade,
 subscription_id uuid not null references private.push_subscriptions(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 group_id uuid references public.groups(id) on delete cascade,
 category text not null check(category in ('expenses','refunds','repayments','test')),
 entity_id uuid,
 actor_id uuid references public.profiles(id) on delete cascade,
 binding uuid not null,
 status text not null default 'pending' check(status in ('pending','leased','sent','skipped','dead')),
 attempts integer not null default 0 check(attempts between 0 and 8),
 available_at timestamptz not null default clock_timestamp(),
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
 sent_at timestamptz,
 last_status integer,
 unique(activity_id,subscription_id)
);
create index notification_outbox_pending on private.notification_outbox(available_at) where status in ('pending','leased');
create index notification_outbox_owner on private.notification_outbox(user_id,created_at desc);
alter table private.notification_preferences enable row level security;
alter table private.push_subscriptions enable row level security;
alter table private.notification_outbox enable row level security;
revoke all on private.notification_preferences,private.push_subscriptions,private.notification_outbox from public,anon,authenticated;

create function private.notification_session_active(p_session uuid,p_user uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 return exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
  where s.id=p_session and s.user_id=p_user and (s.not_after is null or s.not_after>now())
  and u.email_confirmed_at is not null and u.raw_app_meta_data->'providers' @> '["google"]'::jsonb
  and (nullif(to_jsonb(u)->>'banned_until','')::timestamptz is null or (to_jsonb(u)->>'banned_until')::timestamptz<now()));
end $$;
create function private.notification_session() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=private.require_user(); sid uuid;
begin
 begin sid:=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid;
 exception when invalid_text_representation then raise exception 'unauthenticated: sign in again to manage notifications' using errcode='28000';end;
 if sid is null or not private.notification_session_active(sid,actor) then raise exception 'unauthenticated: sign in again to manage notifications' using errcode='28000';end if;
 return sid;
end $$;
create function private.notification_member(p_user uuid,p_group uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.group_members m join public.groups g on g.id=m.group_id
  where m.user_id=p_user and m.group_id=p_group and m.status='active'
  and (g.kind<>'trip' or exists(select 1 from public.group_members parent
   where parent.group_id=g.parent_household_id and parent.user_id=p_user and parent.status='active')))
$$;
create function private.push_endpoint_valid(p_endpoint text) returns boolean
language sql immutable set search_path='' as $$
 select p_endpoint is not null and length(p_endpoint) between 30 and 4096
 and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com)/[^[:space:]?#\\]+$'
$$;
create function private.get_notification_preferences() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user(); result jsonb;
begin
 select jsonb_build_object('expenses',expenses,'refunds',refunds,'repayments',repayments,'tone',tone)
 into result from private.notification_preferences where user_id=actor;
 return coalesce(result,'{"expenses":true,"refunds":true,"repayments":true,"tone":"friendly"}'::jsonb);
end $$;
create function private.set_notification_preferences(p_expenses boolean,p_refunds boolean,p_repayments boolean,p_tone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();
begin
 if p_expenses is null or p_refunds is null or p_repayments is null or p_tone is null or p_tone not in ('friendly','brief') then raise exception 'invalid_notification_preferences' using errcode='22023';end if;
 insert into private.notification_preferences(user_id,expenses,refunds,repayments,tone) values(actor,p_expenses,p_refunds,p_repayments,p_tone)
 on conflict(user_id) do update set expenses=excluded.expenses,refunds=excluded.refunds,repayments=excluded.repayments,tone=excluded.tone;
 return private.get_notification_preferences();
end $$;
create function private.register_push_subscription(p_device uuid,p_endpoint text,p_p256dh text,p_auth text,p_binding uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user(); sid uuid:=private.notification_session(); old private.push_subscriptions;
begin
 if p_device is null or p_binding is null or not private.push_endpoint_valid(p_endpoint)
 or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}=?$'
 or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}={0,2}$' then raise exception 'invalid_push_subscription' using errcode='22023';end if;
 if octet_length(decode(translate(rtrim(p_p256dh,'='),'-_','+/')||'=','base64'))<>65
 or get_byte(decode(translate(rtrim(p_p256dh,'='),'-_','+/')||'=','base64'),0)<>4
 or octet_length(decode(translate(rtrim(p_auth,'='),'-_','+/')||'==','base64'))<>16 then raise exception 'invalid_push_subscription' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('push-owner:'||actor::text,0));
 select * into old from private.push_subscriptions where id=p_device for update;
 if found and old.user_id<>actor then raise exception 'push_device_conflict: reset notifications on this device' using errcode='42501';end if;
 if exists(select 1 from private.push_subscriptions where endpoint=p_endpoint and id<>p_device) then raise exception 'push_endpoint_conflict: reset notifications on this device' using errcode='23505';end if;
 if (old.id is null or old.revoked_at is not null) and (select count(*) from private.push_subscriptions where user_id=actor and revoked_at is null)>=10 then raise exception 'push_device_limit: turn off notifications on an older device first' using errcode='23514';end if;
 insert into private.push_subscriptions(id,user_id,session_id,endpoint,p256dh,auth,binding)
 values(p_device,actor,sid,p_endpoint,rtrim(p_p256dh,'='),rtrim(p_auth,'='),p_binding)
 on conflict(id) do update set session_id=excluded.session_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,binding=excluded.binding,
 enabled_at=case when private.push_subscriptions.revoked_at is null and private.push_subscriptions.session_id=excluded.session_id and private.push_subscriptions.binding=excluded.binding then private.push_subscriptions.enabled_at else clock_timestamp() end,
 updated_at=clock_timestamp(),revoked_at=null;
 return jsonb_build_object('id',p_device,'enabled',true);
end $$;
create function private.get_push_subscription(p_device uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user(); sid uuid:=private.notification_session();
begin
 return jsonb_build_object('id',p_device,'enabled',exists(select 1 from private.push_subscriptions where id=p_device and user_id=actor and session_id=sid and revoked_at is null));
end $$;
create function private.revoke_push_subscription(p_device uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();
begin
 update private.notification_outbox set status='skipped',lease_token=null,lease_until=null where subscription_id=p_device and user_id=actor and status in ('pending','leased');
 update private.push_subscriptions set revoked_at=clock_timestamp() where id=p_device and user_id=actor and revoked_at is null;
 return true;
end $$;
create function private.send_test_notification(p_device uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user(); sid uuid:=private.notification_session(); sub private.push_subscriptions; result uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('push-test:'||actor::text,0));
 select * into sub from private.push_subscriptions where id=p_device and user_id=actor and session_id=sid and revoked_at is null for update;
 if not found then raise exception 'push_not_enabled: enable notifications on this device first';end if;
 if exists(select 1 from private.notification_outbox where user_id=actor and category='test' and created_at>clock_timestamp()-interval '1 minute') then raise exception 'push_test_rate_limit: wait one minute before testing again';end if;
 insert into private.notification_outbox(subscription_id,user_id,category,binding,expires_at) values(sub.id,actor,'test',sub.binding,clock_timestamp()+interval '10 minutes') returning id into result;
 return result;
end $$;

create function private.enqueue_transaction_notifications() returns trigger
language plpgsql security definer set search_path='' as $$
declare category text; participants uuid[]; expense public.expenses; refund public.expense_refunds;
begin
 if new.action in ('expense_created','expense_corrected','expense_voided') then
  category:='expenses';select * into expense from public.expenses where id=new.entity_id and group_id=new.group_id;
  if not found then return new;end if;
  -- The deferred trigger sees the replacement relationship created later in save_expense.
  if new.action='expense_created' and expense.replaces_id is not null then return new;end if;
  select array_agg(distinct who) into participants from (
   select e.cash_actor_id who from public.expenses e where e.group_id=new.group_id and (e.id=expense.id or (new.action='expense_corrected' and e.id=expense.replaces_id))
   union select s.user_id from public.expense_shares s where s.group_id=new.group_id and (s.expense_id=expense.id or (new.action='expense_corrected' and s.expense_id=expense.replaces_id))
  ) involved;
 elsif new.action in ('refund_recorded','refund_voided') then
  category:='refunds';select * into refund from public.expense_refunds where id=new.entity_id and group_id=new.group_id;
  if not found then return new;end if;
  select array_agg(distinct who) into participants from (
   select e.cash_actor_id who from public.expenses e where e.id=refund.expense_id and e.group_id=new.group_id
   union select r.user_id from public.refund_shares r where r.refund_id=refund.id and r.group_id=new.group_id and r.share_cents>0
  ) involved;
 elsif new.action in ('payment_recorded','payment_received','payment_confirmed','payment_rejected','payment_cancelled','payment_reversed') then
  category:='repayments';select array[p.sender_id,p.recipient_id] into participants from public.payments p where p.id=new.entity_id and p.group_id=new.group_id;
 else return new;
 end if;
 insert into private.notification_outbox(activity_id,subscription_id,user_id,group_id,category,entity_id,actor_id,binding)
 select new.id,s.id,s.user_id,new.group_id,category,new.entity_id,new.actor_id,s.binding
 from private.push_subscriptions s left join private.notification_preferences pref on pref.user_id=s.user_id
 where s.user_id=any(participants) and s.user_id<>new.actor_id and s.revoked_at is null
 and s.enabled_at<=new.occurred_at and private.notification_session_active(s.session_id,s.user_id)
 and private.notification_member(s.user_id,new.group_id)
 and case category when 'expenses' then coalesce(pref.expenses,true) when 'refunds' then coalesce(pref.refunds,true) else coalesce(pref.repayments,true) end
 on conflict(activity_id,subscription_id) do nothing;
 return new;
end $$;
create constraint trigger queue_transaction_notifications after insert on public.activity_log
 deferrable initially deferred for each row execute function private.enqueue_transaction_notifications();

-- These RPCs are worker-only. Claiming a lease never exposes a subscription to app users.
create function private.claim_notification_deliveries(p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid_batch_size';end if;
 -- Bound private delivery history; no financial records are removed.
 delete from private.notification_outbox where status in ('sent','skipped','dead') and created_at<clock_timestamp()-interval '7 days';
 delete from private.push_subscriptions where revoked_at<clock_timestamp()-interval '30 days';
 update private.notification_outbox set status='dead',lease_token=null,lease_until=null
 where status in ('pending','leased') and (expires_at<=clock_timestamp() or (attempts>=8 and (lease_until is null or lease_until<=clock_timestamp())));
 with candidates as (
  select id from private.notification_outbox where expires_at>clock_timestamp() and attempts<8
  and ((status='pending' and available_at<=clock_timestamp()) or (status='leased' and lease_until<=clock_timestamp()))
  order by available_at,id limit p_limit for update skip locked
 ), claimed as (
  update private.notification_outbox n set status='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
  from candidates c where n.id=c.id returning n.id,n.lease_token
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into result from claimed;
 return result;
end $$;
create function private.get_notification_delivery(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item private.notification_outbox; sub private.push_subscriptions; pref private.notification_preferences;
begin
 select * into item from private.notification_outbox where id=p_id and status='leased' and lease_token=p_lease and lease_until>clock_timestamp() for update;
 if not found then return null;end if;
 select * into sub from private.push_subscriptions where id=item.subscription_id;
 select * into pref from private.notification_preferences where user_id=item.user_id;
 if sub.id is null or sub.user_id<>item.user_id or sub.revoked_at is not null or sub.binding<>item.binding
 or not private.notification_session_active(sub.session_id,sub.user_id) or item.expires_at<=clock_timestamp()
 or not private.push_endpoint_valid(sub.endpoint)
 or (item.category<>'test' and (not private.notification_member(item.user_id,item.group_id)
  or item.user_id=item.actor_id or not case item.category when 'expenses' then coalesce(pref.expenses,true) when 'refunds' then coalesce(pref.refunds,true) else coalesce(pref.repayments,true) end)) then
  update private.notification_outbox set status='skipped',lease_token=null,lease_until=null where id=item.id;return null;
 end if;
 return jsonb_build_object('id',item.id,'endpoint',sub.endpoint,'p256dh',sub.p256dh,'auth',sub.auth,'binding',sub.binding,'category',item.category,'tone',coalesce(pref.tone,'friendly'),'attempts',item.attempts,'expires_at',item.expires_at);
end $$;
create function private.finish_notification_delivery(p_id uuid,p_lease uuid,p_outcome text,p_status integer,p_retry_seconds integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare item private.notification_outbox;
begin
 if p_outcome is null or p_outcome not in ('sent','retry','gone','dead') or p_retry_seconds is null or p_retry_seconds not between 1 and 86400 then raise exception 'invalid_delivery_result';end if;
 select * into item from private.notification_outbox where id=p_id and status='leased' and lease_token=p_lease for update;
 if not found then return false;end if;
 if p_outcome='gone' then update private.push_subscriptions set revoked_at=clock_timestamp() where id=item.subscription_id and binding=item.binding;end if;
 update private.notification_outbox set status=case when p_outcome='sent' then 'sent' when p_outcome='retry' and attempts<8 and expires_at>clock_timestamp()+make_interval(secs=>p_retry_seconds) then 'pending' else 'dead' end,
  available_at=clock_timestamp()+make_interval(secs=>p_retry_seconds),lease_token=null,lease_until=null,last_status=p_status,
  sent_at=case when p_outcome='sent' then clock_timestamp() else null end where id=item.id;
 return true;
end $$;
create function private.resolve_notification(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user(); item private.notification_outbox;
begin
 select * into item from private.notification_outbox where id=p_id and user_id=actor;
 if not found or (item.category<>'test' and not private.notification_member(actor,item.group_id)) then raise exception 'notification_unavailable' using errcode='42501';end if;
 return jsonb_build_object('screen',case when item.category='repayments' then 'balances' when item.category='test' then 'account' else 'expenses' end,'household',item.group_id);
end $$;

create function public.get_notification_preferences() returns jsonb language sql security invoker set search_path='' as $$select private.get_notification_preferences()$$;
create function public.set_notification_preferences(p_expenses boolean,p_refunds boolean,p_repayments boolean,p_tone text) returns jsonb language sql security invoker set search_path='' as $$select private.set_notification_preferences(p_expenses,p_refunds,p_repayments,p_tone)$$;
create function public.register_push_subscription(p_device uuid,p_endpoint text,p_p256dh text,p_auth text,p_binding uuid) returns jsonb language sql security invoker set search_path='' as $$select private.register_push_subscription(p_device,p_endpoint,p_p256dh,p_auth,p_binding)$$;
create function public.get_push_subscription(p_device uuid) returns jsonb language sql security invoker set search_path='' as $$select private.get_push_subscription(p_device)$$;
create function public.revoke_push_subscription(p_device uuid) returns boolean language sql security invoker set search_path='' as $$select private.revoke_push_subscription(p_device)$$;
create function public.send_test_notification(p_device uuid) returns uuid language sql security invoker set search_path='' as $$select private.send_test_notification(p_device)$$;
create function public.resolve_notification(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.resolve_notification(p_id)$$;
create function public.claim_notification_deliveries(p_limit integer default 20) returns jsonb language sql security invoker set search_path='' as $$select private.claim_notification_deliveries(p_limit)$$;
create function public.get_notification_delivery(p_id uuid,p_lease uuid) returns jsonb language sql security invoker set search_path='' as $$select private.get_notification_delivery(p_id,p_lease)$$;
create function public.finish_notification_delivery(p_id uuid,p_lease uuid,p_outcome text,p_status integer default null,p_retry_seconds integer default 60) returns boolean language sql security invoker set search_path='' as $$select private.finish_notification_delivery(p_id,p_lease,p_outcome,p_status,p_retry_seconds)$$;

-- Revoke each exact signature, including private trigger helpers, before granting narrow entry points.
do $$declare fn record; signature text;
begin
 for fn in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.proname in ('notification_session_active','notification_session','notification_member','push_endpoint_valid','get_notification_preferences','set_notification_preferences','register_push_subscription','get_push_subscription','revoke_push_subscription','send_test_notification','enqueue_transaction_notifications','claim_notification_deliveries','get_notification_delivery','finish_notification_delivery','resolve_notification') loop
  signature:=format('%I.%I(%s)',fn.nspname,fn.proname,fn.args);
  execute 'revoke all on function '||signature||' from public,anon,authenticated';
  if fn.proname in ('get_notification_preferences','set_notification_preferences','register_push_subscription','get_push_subscription','revoke_push_subscription','send_test_notification','resolve_notification') then
   execute 'grant execute on function '||signature||' to authenticated';
  elsif fn.proname in ('claim_notification_deliveries','get_notification_delivery','finish_notification_delivery') and exists(select 1 from pg_roles where rolname='service_role') then
   execute 'grant execute on function '||signature||' to service_role';
  end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant usage on schema private to service_role;end if;
end $$;
commit;

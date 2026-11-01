-- Email transport records only. Invitation tokens remain hash-only and the
-- existing email-bound acceptance/access rules are unchanged.
begin;

create table private.invitation_email_deliveries (
 id uuid primary key default gen_random_uuid(),
 invitation_id uuid not null unique references public.invitations(id),
 actor_id uuid not null references public.profiles(id),
 group_id uuid not null references public.groups(id),
 recipient text not null,
 group_name text not null,
 group_kind text not null check(group_kind in ('household','trip')),
 inviter_name text not null,
 expires_at timestamptz not null,
 sender text not null,
 origin text not null,
 template text not null check(template='invitation-v1'),
 config_digest text not null check(config_digest ~ '^[0-9a-f]{64}$'),
 status text not null check(status in ('sending','sent','failed','unknown')),
 first_attempt_at timestamptz not null default clock_timestamp(),
 last_attempt_at timestamptz not null default clock_timestamp(),
 attempts integer not null default 1 check(attempts between 1 and 4),
 lease_id uuid not null,
 lease_expires_at timestamptz not null,
 provider_id text check(provider_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 sent_at timestamptz,
 error_code text check(error_code in ('provider_rejected','provider_unavailable','provider_rate_limit','provider_timeout','delivery_unconfirmed','invalid_metadata')),
 check((status='sent')=(sent_at is not null and provider_id is not null))
);
create index invitation_email_actor_recent on private.invitation_email_deliveries(actor_id,first_attempt_at desc);
create index invitation_email_group_recent on private.invitation_email_deliveries(group_id,first_attempt_at desc);
create index invitation_email_recipient_recent on private.invitation_email_deliveries(recipient,first_attempt_at desc);
alter table private.invitation_email_deliveries enable row level security;
revoke all on private.invitation_email_deliveries from public,anon,authenticated,service_role;

create function private.invitation_email_status_json(d private.invitation_email_deliveries) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object(
  'id',d.id,'invitation_id',d.invitation_id,
  'status',case when d.status='sending' and d.lease_expires_at<=statement_timestamp() then 'unknown' else d.status end,
  'sent_at',d.sent_at,'last_attempt_at',d.last_attempt_at,
  'retry_at',case when d.status in ('sending','unknown') then greatest(d.lease_expires_at,d.last_attempt_at+interval '60 seconds') end,
  'retry_until',least(d.first_attempt_at+interval '23 hours',d.expires_at),
  'can_retry',d.status in ('sending','unknown') and d.lease_expires_at<=statement_timestamp()
   and d.last_attempt_at+interval '60 seconds'<=statement_timestamp() and d.attempts<4
   and least(d.first_attempt_at+interval '23 hours',d.expires_at)>statement_timestamp(),
  'error_code',case when d.status='sending' and d.lease_expires_at<=statement_timestamp() then 'delivery_unconfirmed' else d.error_code end
 )
$$;

create function private.begin_invitation_email(
 p_actor uuid,p_group uuid,p_token_hash text,p_sender text,p_origin text,p_template text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.groups;inv public.invitations;d private.invitation_email_deliveries;claimed boolean:=false;stamp timestamptz;
begin
 -- This function is service-only. The Edge handler supplies the actor only
 -- after Auth.getUser validates the bearer token; no browser can choose it.
 if p_actor is null or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
  where u.id=p_actor and u.email_confirmed_at is not null
   and u.raw_app_meta_data->'providers' @> '["google"]'::jsonb
   and (u.banned_until is null or u.banned_until<=clock_timestamp())) then
  raise exception 'invitation_email_unauthenticated: sign in with a verified Google account' using errcode='28000';
 end if;
 if p_group is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
  or p_sender is null or length(p_sender) not between 3 and 320 or p_sender ~ '[[:cntrl:]]'
  or p_origin is null or length(p_origin)>500 or p_origin !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$'
  or p_template is distinct from 'invitation-v1' then
  raise exception 'invitation_email_invalid_request: invalid email request' using errcode='22023';
 end if;
 -- Group locks precede membership/invitation locks, matching acceptance and
 -- member removal. Effective access includes a household-linked trip parent.
 g:=private.lock_group_scope(p_group);
 if g.id is null or g.archived_at is not null or not private.lock_group_member(p_actor,p_group)
  or not exists(select 1 from public.group_members where group_id=p_group and user_id=p_actor and role='organiser') then
  raise exception 'invitation_email_forbidden: organiser access required' using errcode='42501';
 end if;
 select * into inv from public.invitations where token_hash=p_token_hash and group_id=p_group;
 if not found then raise exception 'invitation_email_invalid_invitation: invitation unavailable';end if;
 -- Every send takes these advisory locks in the same order. Limits cover new
 -- invitations as well as this one, so reissuing links cannot bypass them.
 perform pg_advisory_xact_lock(hashtextextended('invitation-email-actor:'||p_actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended('invitation-email-group:'||p_group::text,0));
 perform pg_advisory_xact_lock(hashtextextended('invitation-email-address:'||inv.intended_email,0));
 perform pg_advisory_xact_lock(hashtextextended('invitation:'||p_group::text||':'||inv.intended_email,0));
 select * into inv from public.invitations where id=inv.id for update;
 stamp:=clock_timestamp();
 if inv.used_at is not null or inv.revoked_at is not null or inv.expires_at<=stamp
  or not private.lock_group_member(inv.created_by,p_group)
  or not exists(select 1 from public.group_members where group_id=p_group and user_id=inv.created_by and role='organiser') then
  raise exception 'invitation_email_invalid_invitation: invitation unavailable';
 end if;
 select * into d from private.invitation_email_deliveries where invitation_id=inv.id for update;
 if found then
  -- Definite failures are terminal. Unknown outcomes may retry the identical
  -- provider payload only while its idempotency key is safely within 24 hours.
  if d.status in ('sending','unknown') and d.lease_expires_at<=stamp
   and d.last_attempt_at+interval '60 seconds'<=stamp and d.attempts<4
   and d.first_attempt_at+interval '23 hours'>stamp then
   update private.invitation_email_deliveries set status='sending',attempts=attempts+1,
    last_attempt_at=stamp,lease_id=gen_random_uuid(),lease_expires_at=stamp+interval '60 seconds',error_code=null
    where id=d.id returning * into d;
   claimed:=true;
  end if;
 else
  if (select count(*) from private.invitation_email_deliveries where actor_id=p_actor and first_attempt_at>stamp-interval '1 hour')>=20
   or (select count(*) from private.invitation_email_deliveries where group_id=p_group and first_attempt_at>stamp-interval '1 day')>=100
   or (select count(*) from private.invitation_email_deliveries where recipient=inv.intended_email and first_attempt_at>stamp-interval '1 hour')>=3
   or exists(select 1 from private.invitation_email_deliveries where recipient=inv.intended_email and first_attempt_at>stamp-interval '60 seconds') then
   raise exception 'invitation_email_rate_limit: too many invitation emails' using errcode='P0001';
  end if;
  insert into private.invitation_email_deliveries(invitation_id,actor_id,group_id,recipient,group_name,group_kind,inviter_name,
   expires_at,sender,origin,template,config_digest,status,first_attempt_at,last_attempt_at,lease_id,lease_expires_at)
   values(inv.id,p_actor,p_group,inv.intended_email,g.name,g.kind,
    (select display_name from public.profiles where id=p_actor),inv.expires_at,p_sender,p_origin,p_template,
    encode(sha256(convert_to(jsonb_build_array(p_sender,p_origin,p_template)::text,'UTF8')),'hex'),
    'sending',stamp,stamp,gen_random_uuid(),stamp+interval '60 seconds') returning * into d;
  claimed:=true;
 end if;
 return private.invitation_email_status_json(d)||jsonb_build_object('claimed',claimed,'lease_id',case when claimed then d.lease_id end,
  'attempts',d.attempts,'recipient',d.recipient,'group_name',d.group_name,'group_kind',d.group_kind,'inviter_name',d.inviter_name,
  'expires_at',d.expires_at,'sender',d.sender,'origin',d.origin,'template',d.template,'config_digest',d.config_digest);
end $$;

create function private.finish_invitation_email(
 p_delivery uuid,p_lease uuid,p_status text,p_provider_id text default null,p_error_code text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.invitation_email_deliveries;
begin
 if p_delivery is null or p_lease is null or p_status is null or p_status not in ('sent','failed','unknown')
  or (p_status='sent' and (p_provider_id is null or p_provider_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_error_code is not null))
  or (p_status<>'sent' and (p_provider_id is not null or p_error_code is null or p_error_code not in
    ('provider_rejected','provider_unavailable','provider_rate_limit','provider_timeout','delivery_unconfirmed','invalid_metadata'))) then
  raise exception 'invitation_email_invalid_request: invalid delivery result' using errcode='22023';
 end if;
 select * into d from private.invitation_email_deliveries where id=p_delivery for update;
 if not found then raise exception 'invitation_email_invalid_request: delivery unavailable';end if;
 if d.status='sending' and d.lease_id=p_lease then
  update private.invitation_email_deliveries set status=p_status,provider_id=p_provider_id,error_code=p_error_code,
   sent_at=case when p_status='sent' then clock_timestamp() end
   where id=d.id returning * into d;
 end if;
 -- A late attempt cannot overwrite a newer lease or regress a confirmed send.
 return private.invitation_email_status_json(d);
end $$;

create function private.get_invitation_email_status(p_group uuid,p_token_hash text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_member(p_group,true);
 if p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invitation_email_invalid_request: invalid invitation digest';end if;
 return coalesce((select jsonb_agg(case when d.id is null then jsonb_build_object(
  'invitation_id',i.id,'status','not_sent','sent_at',null,'last_attempt_at',null,
  'retry_at',null,'retry_until',null,'can_retry',false,'error_code',null)
  else private.invitation_email_status_json(d)-'id' end||jsonb_build_object('intended_email',i.intended_email) order by i.created_at desc)
  from public.invitations i left join private.invitation_email_deliveries d on d.invitation_id=i.id
  where i.group_id=p_group and (p_token_hash is null or i.token_hash=p_token_hash) and i.used_at is null and i.revoked_at is null and i.expires_at>statement_timestamp()),'[]'::jsonb);
end $$;

create function public.begin_invitation_email(p_actor uuid,p_group uuid,p_token_hash text,p_sender text,p_origin text,p_template text)
returns jsonb language sql security invoker set search_path='' as $$
 select private.begin_invitation_email(p_actor,p_group,p_token_hash,p_sender,p_origin,p_template)
$$;
create function public.finish_invitation_email(p_delivery uuid,p_lease uuid,p_status text,p_provider_id text default null,p_error_code text default null)
returns jsonb language sql security invoker set search_path='' as $$
 select private.finish_invitation_email(p_delivery,p_lease,p_status,p_provider_id,p_error_code)
$$;
create function public.get_invitation_email_status(p_group uuid,p_token_hash text default null)
returns jsonb language sql security invoker set search_path='' as $$ select private.get_invitation_email_status(p_group,p_token_hash) $$;

revoke all on function private.invitation_email_status_json(private.invitation_email_deliveries),
 private.begin_invitation_email(uuid,uuid,text,text,text,text),public.begin_invitation_email(uuid,uuid,text,text,text,text),
 private.finish_invitation_email(uuid,uuid,text,text,text),public.finish_invitation_email(uuid,uuid,text,text,text),
 private.get_invitation_email_status(uuid,text),public.get_invitation_email_status(uuid,text) from public,anon,authenticated,service_role;
grant usage on schema private to service_role;
grant execute on function private.begin_invitation_email(uuid,uuid,text,text,text,text),public.begin_invitation_email(uuid,uuid,text,text,text,text),
 private.finish_invitation_email(uuid,uuid,text,text,text),public.finish_invitation_email(uuid,uuid,text,text,text) to service_role;
grant execute on function private.get_invitation_email_status(uuid,text),public.get_invitation_email_status(uuid,text) to authenticated;

commit;

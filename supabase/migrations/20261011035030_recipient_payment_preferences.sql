-- Recipients choose whether new incoming sender reports need approval.
-- Automatic settlement is the default; existing pending records stay pending.
begin;

alter table public.profiles add column require_payment_approval boolean not null default false;
alter table public.payments add column confirmation_method text
 check(confirmation_method in ('recipient','automatic'));
update public.payments set confirmation_method='recipient'
 where status in ('confirmed','reversed') and confirmed_at is not null;

create function private.get_payment_preferences() returns boolean
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user(); preference boolean;
begin
 select require_payment_approval into preference from public.profiles where id=actor;
 if not found then raise exception 'profile_unavailable: your profile could not be found' using errcode='42501';end if;
 return preference;
end $$;

create function private.set_payment_preferences(p_require_approval boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();
begin
 if p_require_approval is null then raise exception 'invalid_payment_preferences' using errcode='22023';end if;
 update public.profiles set require_payment_approval=p_require_approval where id=actor;
 if not found then raise exception 'profile_unavailable: your profile could not be found' using errcode='42501';end if;
 return p_require_approval;
end $$;

create function public.get_payment_preferences() returns boolean
language sql security invoker set search_path='' as $$select private.get_payment_preferences()$$;
create function public.set_payment_preferences(p_require_approval boolean) returns boolean
language sql security invoker set search_path='' as $$select private.set_payment_preferences(p_require_approval)$$;

create or replace function private.insert_repayment(p_group uuid,p_other uuid,p_direction text,p_amount bigint,p_date date,p_note text,p_separate boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=private.require_member(p_group); sender uuid; recipient uuid; parent uuid; pid uuid;
 clean_note text:=btrim(coalesce(p_note,'')); approval_required boolean; method text;
begin
 if p_direction is null or p_direction not in ('sent','received') or p_separate is null
    or p_other is null or p_other=actor then raise exception 'invalid_payment';end if;
 if p_amount is null or p_amount not between 1 and 100000000 then raise exception 'invalid_amount';end if;
 if p_date is null or not isfinite(p_date) or length(clean_note)>500 then raise exception 'invalid_payment';end if;

 select parent_household_id into parent from public.groups where id=p_group and kind='trip';
 if parent is not null then
  perform 1 from public.group_members where group_id=parent and user_id=p_other and status='active' for share;
  if not found then raise exception 'invalid_payment';end if;
 end if;
 perform 1 from public.group_members where group_id=p_group and user_id=p_other and status='active' for share;
 if not found then raise exception 'invalid_payment';end if;

 sender:=case when p_direction='sent' then actor else p_other end;
 recipient:=case when p_direction='received' then actor else p_other end;
 perform private.lock_payment_pair(p_group,sender,recipient);

 -- Serialize this decision with the recipient's own preference update. Existing
 -- rows retain the decision made when recorded, including unresolved pending rows.
 select require_payment_approval into approval_required from public.profiles where id=recipient for share;
 if not found then raise exception 'invalid_payment';end if;
 method:=case when p_direction='received' then 'recipient' when not approval_required then 'automatic' else null end;

 -- Never guess whether a pending report refers to the money just received.
 -- The recipient must confirm or reject that existing report explicitly first.
 if p_direction='received' and exists(select 1 from public.payments
  where group_id=p_group and sender_id=sender and recipient_id=recipient and status='pending') then
  raise exception 'payment_pending_exists';
 end if;
 -- Equal amounts on the same date can be distinct transfers. Only a deliberate
 -- separate-payment acknowledgement through the new API may bypass this guard.
 if not p_separate and exists(select 1 from public.payments
  where group_id=p_group and sender_id=sender and recipient_id=recipient
   and occurred_on=p_date and amount_cents=p_amount and status in ('pending','confirmed')) then
  raise exception 'payment_already_recorded';
 end if;

 insert into public.payments(group_id,sender_id,recipient_id,amount_cents,occurred_on,note,status,confirmed_at,recorded_by,confirmation_method)
 values(p_group,sender,recipient,p_amount,p_date,clean_note,
  case when method is not null then 'confirmed' else 'pending' end,
  case when method is not null then now() else null end,actor,method) returning id into pid;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data)
 values(p_group,actor,case when p_direction='received' then 'payment_received' else 'payment_recorded' end,pid,
  jsonb_build_object('sender_id',sender,'recipient_id',recipient,'amount_cents',p_amount,'occurred_on',p_date,'separate_payment',p_separate,'confirmation_method',method));
 return pid;
end $$;

create or replace function private.payment_action(p_group uuid,p_payment uuid,p_action text,p_version integer,p_reason text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('payment_action',p_group,p_payment,p_action,p_version,p_reason);prior uuid;actor uuid;pay public.payments;next_status text;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 -- Participants never change. Read the pair, acquire its lock, then reload and
 -- lock the row so confirmation, cancellation and reversal use fresh state.
 select * into pay from public.payments where id=p_payment and group_id=p_group;
 if not found then raise exception 'invalid_payment';end if;
 perform private.lock_payment_pair(p_group,pay.sender_id,pay.recipient_id);
 select * into pay from public.payments where id=p_payment and group_id=p_group for update;
 if pay.version<>p_version or p_version is null then raise exception 'stale_version';end if;
 if p_action in ('confirm','reject') and pay.recipient_id=actor and pay.status='pending' then next_status:=case when p_action='confirm' then 'confirmed' else 'rejected' end;
 elsif p_action='cancel' and pay.sender_id=actor and pay.status='pending' then next_status:='cancelled';
 elsif p_action='reverse' and pay.status='confirmed' and (pay.recipient_id=actor or private.is_organiser(p_group)) then
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'reason_required';end if;next_status:='reversed';
 else raise exception 'invalid_action';end if;
 update public.payments set status=next_status,version=version+1,reason=btrim(coalesce(p_reason,'')),confirmed_at=case when next_status='confirmed' then now() else confirmed_at end,
  confirmation_method=case when next_status='confirmed' then 'recipient' else confirmation_method end where id=p_payment;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'payment_'||next_status,p_payment,jsonb_build_object('reason',p_reason,'confirmation_method',case when next_status='confirmed' then 'recipient' else pay.confirmation_method end));
 return private.operation_done(p_group,p_request,body,p_payment);
end $$;

create or replace function private.household_state(p_group uuid,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_user();if not private.is_member(p_group) then raise exception 'forbidden' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 10000 then raise exception 'invalid_limit';end if;
 with recent as (select * from public.expenses where group_id=p_group order by occurred_on desc,created_at desc,id limit p_limit),
 ledger as (
  select cash_actor_id as user_id,amount_cents as cents from public.expenses where group_id=p_group and status='posted'
  union all select s.user_id,-s.share_cents from public.expense_shares s join public.expenses e on e.id=s.expense_id where s.group_id=p_group and e.status='posted'
  union all select sender_id,amount_cents from public.payments where group_id=p_group and status='confirmed'
  union all select recipient_id,-amount_cents from public.payments where group_id=p_group and status='confirmed'
  union all select e.cash_actor_id,-r.amount_cents from public.expense_refunds r join public.expenses e on e.id=r.expense_id where r.group_id=p_group and r.status='posted'
  union all select s.user_id,s.share_cents from public.refund_shares s join public.expense_refunds r on r.id=s.refund_id where s.group_id=p_group and r.status='posted'
 ),totals as (select user_id,sum(cents) as cents from ledger group by user_id)
 select jsonb_build_object(
 'schema_version',3,
 'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id,'name',p.display_name,'role',m.role,'status',m.status,'require_payment_approval',p.require_payment_approval) order by p.display_name) from public.group_members m join public.profiles p on p.id=m.user_id where m.group_id=p_group),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_on desc,e.created_at desc,e.id) from recent e),'[]'::jsonb),
 'expense_count',(select count(*) from public.expenses where group_id=p_group),
 'shares',coalesce((select jsonb_agg(to_jsonb(s)) from public.expense_shares s join recent e on e.id=s.expense_id),'[]'::jsonb),
 'balances',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'cents',coalesce(t.cents,0))) from public.group_members m left join totals t on t.user_id=m.user_id where m.group_id=p_group),'[]'::jsonb),
 'shopping',coalesce((select jsonb_agg(to_jsonb(i) order by urgent desc,created_at desc) from public.shopping_items i where group_id=p_group),'[]'::jsonb),
 'purchases',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc) from public.shopping_purchases p where group_id=p_group),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc) from public.payments p where group_id=p_group),'[]'::jsonb),
 'refunds',coalesce((select jsonb_agg(to_jsonb(r) order by created_at desc) from public.expense_refunds r where group_id=p_group),'[]'::jsonb),
 'refund_shares',coalesce((select jsonb_agg(to_jsonb(s)) from public.refund_shares s where group_id=p_group),'[]'::jsonb),
 'activity',coalesce((select jsonb_agg(to_jsonb(a) order by occurred_at desc) from (select * from public.activity_log where group_id=p_group order by occurred_at desc,id limit 100) a),'[]'::jsonb),
 'invitations',case when private.is_organiser(p_group) then coalesce((select jsonb_agg(jsonb_build_object('id',id,'intended_email',intended_email,'expires_at',expires_at)) from public.invitations where group_id=p_group and used_at is null and revoked_at is null and expires_at>now()),'[]'::jsonb) else '[]'::jsonb end
 ) into result;
 return result;
end $$;
revoke all on function private.get_payment_preferences(),public.get_payment_preferences(),
 private.set_payment_preferences(boolean),public.set_payment_preferences(boolean) from public,anon,authenticated;
grant execute on function private.get_payment_preferences(),public.get_payment_preferences(),
 private.set_payment_preferences(boolean),public.set_payment_preferences(boolean) to authenticated;

commit;

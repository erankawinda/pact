-- Either participant may record a transfer. Only its recipient can acknowledge
-- receipt, so a recipient-created record is confirmed immediately.
begin;

alter table public.payments add column recorded_by uuid references public.profiles(id);
update public.payments set recorded_by=sender_id;
alter table public.payments alter column recorded_by set not null;
alter table public.payments add constraint payment_recorder_is_participant
 check(recorded_by=sender_id or recorded_by=recipient_id);
create index payments_recorder on public.payments(recorded_by);
create index payments_live_pair on public.payments(group_id,sender_id,recipient_id,occurred_on,amount_cents)
 where status in ('pending','confirmed');

-- All payment writers take this lock before any payment row lock. There need
-- not be an existing row: simultaneous sender/recipient inserts must serialize.
create function private.lock_payment_pair(p_group uuid,p_sender uuid,p_recipient uuid) returns void
language sql security invoker set search_path='' as $$
 select pg_advisory_xact_lock(hashtextextended('pact:payment:'||p_group::text||':'||p_sender::text||':'||p_recipient::text,0))
$$;

-- Internal only. Public RPCs own the request receipt and call this helper within
-- the same transaction. Membership checks stay inside the privileged boundary.
create function private.insert_repayment(p_group uuid,p_other uuid,p_direction text,p_amount bigint,p_date date,p_note text,p_separate boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=private.require_member(p_group); sender uuid; recipient uuid; parent uuid; pid uuid;
 clean_note text:=btrim(coalesce(p_note,''));
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

 insert into public.payments(group_id,sender_id,recipient_id,amount_cents,occurred_on,note,status,confirmed_at,recorded_by)
 values(p_group,sender,recipient,p_amount,p_date,clean_note,
  case when p_direction='received' then 'confirmed' else 'pending' end,
  case when p_direction='received' then now() else null end,actor) returning id into pid;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data)
 values(p_group,actor,case when p_direction='received' then 'payment_received' else 'payment_recorded' end,pid,
  jsonb_build_object('sender_id',sender,'recipient_id',recipient,'amount_cents',p_amount,'occurred_on',p_date,'separate_payment',p_separate));
 return pid;
end $$;

create function private.record_repayment(p_group uuid,p_other uuid,p_direction text,p_amount bigint,p_date date,p_note text,p_separate boolean,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 body jsonb:=jsonb_build_array('record_repayment',p_group,p_other,p_direction,p_amount,p_date,p_note,p_separate);
 prior uuid;pid uuid;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;
 pid:=private.insert_repayment(p_group,p_other,p_direction,p_amount,p_date,p_note,p_separate);
 return private.operation_done(p_group,p_request,body,pid);
end $$;

-- Preserve the old signature and exact body hash, including request receipts
-- created before this migration. Old clients still record money sent as pending.
create or replace function private.record_payment(p_group uuid,p_recipient uuid,p_amount bigint,p_date date,p_note text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('payment',p_group,p_recipient,p_amount,p_date,p_note);prior uuid;pid uuid;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;
 pid:=private.insert_repayment(p_group,p_recipient,'sent',p_amount,p_date,p_note,false);
 return private.operation_done(p_group,p_request,body,pid);
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
 update public.payments set status=next_status,version=version+1,reason=btrim(coalesce(p_reason,'')),confirmed_at=case when next_status='confirmed' then now() else confirmed_at end where id=p_payment;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'payment_'||next_status,p_payment,jsonb_build_object('reason',p_reason));
 return private.operation_done(p_group,p_request,body,p_payment);
end $$;

create function public.record_repayment(p_group uuid,p_other uuid,p_direction text,p_amount bigint,p_date date,p_note text,p_separate boolean,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$
 select private.record_repayment(p_group,p_other,p_direction,p_amount,p_date,p_note,p_separate,p_request)
$$;

revoke all on function private.lock_payment_pair(uuid,uuid,uuid),
 private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean) from public,anon,authenticated;
revoke all on function private.record_repayment(uuid,uuid,text,bigint,date,text,boolean,uuid),
 public.record_repayment(uuid,uuid,text,bigint,date,text,boolean,uuid) from public,anon,authenticated;
grant execute on function private.record_repayment(uuid,uuid,text,bigint,date,text,boolean,uuid),
 public.record_repayment(uuid,uuid,text,bigint,date,text,boolean,uuid) to authenticated;

commit;

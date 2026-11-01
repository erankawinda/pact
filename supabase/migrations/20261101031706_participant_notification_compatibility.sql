-- Optional Web Push compatibility for stable ledger participants. This never
-- installs notification tables, devices, preferences, or a dispatch schedule.
begin;

do $compatibility$
begin
 if to_regprocedure('private.enqueue_transaction_notifications()') is not null then
  if to_regprocedure('private.participant_auth_user(uuid,uuid)') is null then
   raise exception 'participant_migration_required: apply group participants first';
  end if;
  execute $definition$
   create or replace function private.enqueue_transaction_notifications() returns trigger
   language plpgsql security definer set search_path='' as $body$
   declare category text; participants uuid[]; expense public.expenses; refund public.expense_refunds;
   begin
    if new.action in ('expense_created','expense_corrected','expense_voided') then
     category:='expenses';select * into expense from public.expenses where id=new.entity_id and group_id=new.group_id;
     if not found then return new;end if;
     -- The deferred trigger sees a correction's replacement relationship.
     if new.action='expense_created' and expense.replaces_id is not null then return new;end if;
     select array_agg(distinct who) into participants from (
      select e.cash_actor_id who from public.expenses e where e.group_id=new.group_id
       and (e.id=expense.id or (new.action='expense_corrected' and e.id=expense.replaces_id))
      union select s.user_id from public.expense_shares s where s.group_id=new.group_id
       and (s.expense_id=expense.id or (new.action='expense_corrected' and s.expense_id=expense.replaces_id))
     ) involved;
    elsif new.action in ('refund_recorded','refund_voided') then
     category:='refunds';select * into refund from public.expense_refunds where id=new.entity_id and group_id=new.group_id;
     if not found then return new;end if;
     select array_agg(distinct who) into participants from (
      select e.cash_actor_id who from public.expenses e where e.id=refund.expense_id and e.group_id=new.group_id
      union select r.user_id from public.refund_shares r where r.refund_id=refund.id and r.group_id=new.group_id and r.share_cents>0
     ) involved;
    elsif new.action in ('payment_recorded','payment_received','payment_confirmed','payment_rejected','payment_cancelled','payment_reversed') then
     category:='repayments';select array[p.sender_id,p.recipient_id] into participants
      from public.payments p where p.id=new.entity_id and p.group_id=new.group_id;
    else return new;
    end if;
    -- Financial rows hold participant IDs. Devices, sessions, preferences and
    -- activity actors still hold authenticated-user IDs. Resolve inside this
    -- private function; never treat an unclaimed participant as an account.
    select array_agg(distinct p.auth_user_id) into participants
     from public.group_participants p
     where p.group_id=new.group_id and p.id=any(participants) and p.auth_user_id is not null
      and p.joined_at<=new.occurred_at;
    -- The timestamp gate also protects a deferred trigger from a participant
    -- claimed later in the same transaction. Claiming itself emits no alert.
    insert into private.notification_outbox(activity_id,subscription_id,user_id,group_id,category,entity_id,actor_id,binding)
    select new.id,s.id,s.user_id,new.group_id,category,new.entity_id,new.actor_id,s.binding
    from private.push_subscriptions s left join private.notification_preferences pref on pref.user_id=s.user_id
    where s.user_id=any(participants) and s.user_id<>new.actor_id and s.revoked_at is null
     and s.enabled_at<=new.occurred_at and private.notification_session_active(s.session_id,s.user_id)
     and private.notification_member(s.user_id,new.group_id)
     and case category when 'expenses' then coalesce(pref.expenses,true) when 'refunds' then coalesce(pref.refunds,true) else coalesce(pref.repayments,true) end
    on conflict(activity_id,subscription_id) do nothing;
    return new;
   end $body$
  $definition$;
 end if;
end $compatibility$;

commit;

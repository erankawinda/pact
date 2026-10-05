-- Pact 0.3: additive household workflows and safe operation replay.
-- Existing expenses and shares are retained. No records are deleted.
begin;

alter table public.expenses add column replaces_id uuid references public.expenses(id);
alter table public.expenses add column correction_reason text not null default '' check(length(correction_reason)<=500);
create unique index expense_replacement on public.expenses(replaces_id) where replaces_id is not null;

create table public.shopping_items (
 id uuid primary key default gen_random_uuid(), group_id uuid not null references public.groups(id),
 name text not null check(length(btrim(name)) between 1 and 100),
 quantity numeric(12,3) not null check(quantity>0 and quantity<=100000),
 remaining numeric(12,3) not null check(remaining>=0 and remaining<=quantity),
 unit text not null default 'items' check(length(unit) between 1 and 30), note text not null default '' check(length(note)<=500),
 urgent boolean not null default false, status text not null default 'needed' check(status in ('needed','bought','removed')),
 claimed_by uuid, created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(),
 version integer not null default 1, unique(group_id,id),
 foreign key(group_id,claimed_by) references public.group_members(group_id,user_id),
 check((status='bought' and remaining=0) or status<>'bought')
);
create unique index shopping_needed_name on public.shopping_items(group_id,lower(btrim(name)),lower(btrim(unit))) where status='needed';
create index shopping_claimant on public.shopping_items(group_id,claimed_by) where claimed_by is not null;
create index shopping_creator on public.shopping_items(created_by);

create table public.shopping_purchases (
 id uuid primary key default gen_random_uuid(), group_id uuid not null,
 item_id uuid not null, quantity numeric(12,3) not null check(quantity>0),
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 expense_id uuid unique,undone_at timestamptz,
 foreign key(group_id,item_id) references public.shopping_items(group_id,id),
 foreign key(group_id,expense_id) references public.expenses(group_id,id)
);
create index purchases_group on public.shopping_purchases(group_id,created_at desc);
create index purchases_item on public.shopping_purchases(group_id,item_id);
create index purchases_expense on public.shopping_purchases(group_id,expense_id);
create index purchases_creator on public.shopping_purchases(created_by);

create table public.payments (
 id uuid primary key default gen_random_uuid(),group_id uuid not null references public.groups(id),
 sender_id uuid not null,recipient_id uuid not null,amount_cents bigint not null check(amount_cents between 1 and 100000000),
 occurred_on date not null,note text not null default '' check(length(note)<=500),
 status text not null default 'pending' check(status in ('pending','confirmed','cancelled','rejected','reversed')),
 reason text not null default '' check(length(reason)<=500),version integer not null default 1,
 created_at timestamptz not null default now(),confirmed_at timestamptz,
 foreign key(group_id,sender_id) references public.group_members(group_id,user_id),
 foreign key(group_id,recipient_id) references public.group_members(group_id,user_id),check(sender_id<>recipient_id)
);
create index payments_group on public.payments(group_id,created_at desc);
create index payments_sender on public.payments(group_id,sender_id);
create index payments_recipient on public.payments(group_id,recipient_id);

create table public.expense_refunds (
 id uuid primary key default gen_random_uuid(),group_id uuid not null,expense_id uuid not null,
 amount_cents bigint not null check(amount_cents between 1 and 100000000),
 reason text not null check(length(btrim(reason)) between 1 and 500),
 status text not null default 'posted' check(status in ('posted','voided')),
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 unique(group_id,id), foreign key(group_id,expense_id) references public.expenses(group_id,id)
);
create index refunds_expense on public.expense_refunds(group_id,expense_id);
create index refunds_group on public.expense_refunds(group_id);
create index refunds_creator on public.expense_refunds(created_by);
create table public.refund_shares (
 refund_id uuid not null,user_id uuid not null,group_id uuid not null,share_cents bigint not null check(share_cents>=0),
 primary key(refund_id,user_id),foreign key(group_id,refund_id) references public.expense_refunds(group_id,id),
 foreign key(group_id,user_id) references public.group_members(group_id,user_id)
);
create index refund_shares_group on public.refund_shares(group_id,user_id);

create index refund_shares_refund on public.refund_shares(group_id,refund_id);


-- A household revocation also gates trip access at read/write time. The parent
-- membership lock prevents concurrent invite acceptance restoring revoked access.
create or replace function private.is_member(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.group_members m join public.groups g on g.id=m.group_id
  where m.group_id=target and m.user_id=auth.uid() and m.status='active'
  and (g.kind<>'trip' or exists(select 1 from public.group_members parent
   where parent.group_id=g.parent_household_id and parent.user_id=auth.uid() and parent.status='active')))
$$;
create or replace function private.can_read_profile(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select target=auth.uid() or exists(select 1 from public.group_members me join public.group_members other using(group_id)
  where me.user_id=auth.uid() and other.user_id=target and private.is_member(me.group_id))
$$;
create or replace function private.require_member(target uuid,organiser boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();g public.groups;
begin
 select * into g from public.groups where id=target and archived_at is null for share;
 if not found then raise exception 'forbidden: group access unavailable' using errcode='42501';end if;
 if g.kind='trip' then
  perform 1 from public.group_members where group_id=g.parent_household_id and user_id=actor and status='active' for share;
  if not found then raise exception 'forbidden: household access unavailable' using errcode='42501';end if;
 end if;
 perform 1 from public.group_members where group_id=target and user_id=actor and status='active'
  and (not organiser or role='organiser') for share;
 if not found then raise exception 'forbidden: group access unavailable' using errcode='42501';end if;
 return actor;
end $$;
create or replace function private.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_user(); inv public.invitations; address text;
begin
  if p_token is null or length(p_token)<>64 then raise exception 'invalid_invitation'; end if;
  select lower(email) into address from auth.users where id=actor;
  select * into inv from public.invitations where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
  if not found or inv.intended_email<>address or inv.revoked_at is not null or inv.expires_at<=now() then raise exception 'invalid_invitation'; end if;
  if inv.used_at is not null then
    if inv.used_by=actor and private.is_member(inv.group_id) then return inv.group_id; end if;
    raise exception 'invalid_invitation';
  end if;
  perform 1 from public.groups where id=inv.group_id and archived_at is null for share;
  if not found then raise exception 'invalid_invitation'; end if;
  if exists(select 1 from public.groups where id=inv.group_id and kind='trip') then
    perform 1 from public.groups g join public.group_members m on m.group_id=g.parent_household_id
      where g.id=inv.group_id and m.user_id=actor and m.status='active' for share of m;
    if not found then raise exception 'trip_member_must_belong_to_household';end if;
  end if;
  insert into public.group_members(group_id,user_id,role) values(inv.group_id,actor,'member')
    on conflict(group_id,user_id) do update set status='active',left_at=null,joined_at=now();
  update public.invitations set used_at=now(),used_by=actor where id=inv.id;
  insert into public.activity_log(group_id,actor_id,action,entity_id) values(inv.group_id,actor,'member_joined',actor);
  return inv.group_id;
end $$;

-- Internal helpers are not granted to clients. Public wrappers below are invoker functions.
create function private.operation_replay(p_request uuid,p_body jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();prior public.operation_requests; digest text;
begin
 if p_request is null then raise exception 'invalid_request';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||p_request::text,0));
 digest:=encode(sha256(convert_to(p_body::text,'UTF8')),'hex');
 select * into prior from public.operation_requests where actor_id=actor and request_id=p_request;
 if found then
  if prior.payload_hash<>digest then raise exception 'idempotency_conflict';end if;
  return prior.result_id;
 end if;
 return null;
end $$;
create function private.operation_done(p_group uuid,p_request uuid,p_body jsonb,p_result uuid) returns uuid
language plpgsql security definer set search_path='' as $$
begin
 insert into public.operation_requests(actor_id,request_id,group_id,payload_hash,result_id)
 values(private.require_user(),p_request,p_group,encode(sha256(convert_to(p_body::text,'UTF8')),'hex'),p_result);
 return p_result;
end $$;
create function private.is_organiser(p_group uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.is_member(p_group) and exists(select 1 from public.group_members where group_id=p_group and user_id=auth.uid() and status='active' and role='organiser')
$$;

create function private.create_space(p_name text,p_kind text,p_parent uuid,p_people uuid[],p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('space',p_name,p_kind,p_parent,p_people); prior uuid;gid uuid;actor uuid:=private.require_user();person uuid;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;
 gid:=private.create_group(p_name,p_kind,p_parent);
 if p_kind='trip' then
  if cardinality(p_people)>100 or array_position(p_people,null) is not null then raise exception 'invalid_split';end if;
  for person in select distinct unnest(p_people) loop
   perform 1 from public.group_members where group_id=p_parent and user_id=person and status='active' for share;
   if not found then raise exception 'trip_member_must_belong_to_household';end if;
   insert into public.group_members(group_id,user_id,role) values(gid,person,'member') on conflict do nothing;
  end loop;
 end if;
 return private.operation_done(gid,p_request,body,gid);
end $$;

create function private.save_expense(p_input jsonb,p_replaces uuid default null,p_version integer default null,p_reason text default '',p_purchase uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare gid uuid:=(p_input->>'p_group')::uuid;request uuid:=(p_input->>'p_request')::uuid;
 body jsonb:=jsonb_build_array('save_expense',p_input,p_replaces,p_version,p_reason,p_purchase);prior uuid;actor uuid;eid uuid;old public.expenses;purchase public.shopping_purchases;
begin
 prior:=private.operation_replay(request,body);if prior is not null then return prior;end if;
 actor:=private.require_member(gid);
 if p_replaces is not null then
  select * into old from public.expenses where id=p_replaces and group_id=gid for update;
  if not found or (old.created_by<>actor and not private.is_organiser(gid)) then raise exception 'forbidden' using errcode='42501';end if;
  if old.version<>p_version or p_version is null or old.status<>'posted' then raise exception 'stale_version';end if;
  if length(btrim(p_reason)) not between 1 and 500 or p_reason is null then raise exception 'reason_required';end if;
  if exists(select 1 from public.expense_refunds where expense_id=p_replaces and status='posted') then raise exception 'has_refunds';end if;
 end if;
 if p_purchase is not null then
  select * into purchase from public.shopping_purchases where id=p_purchase and group_id=gid for update;
  if not found or purchase.undone_at is not null or purchase.expense_id is not null then raise exception 'purchase_linked';end if;
  if purchase.created_by<>actor and not private.is_organiser(gid) then raise exception 'forbidden' using errcode='42501';end if;
 end if;
 -- The child receipt and parent receipt commit together. Parent retries never create another charge.
 eid:=private.create_expense(gid,gen_random_uuid(),p_input->>'p_description',(p_input->>'p_amount')::bigint,(p_input->>'p_payer')::uuid,
  array(select jsonb_array_elements_text(p_input->'p_people')::uuid),p_input->>'p_mode',p_input->'p_exact',(p_input->>'p_date')::date,p_input->>'p_category',p_input->>'p_note');
 if p_replaces is not null then
  update public.expenses set status='voided',version=version+1 where id=p_replaces;
  update public.expenses set replaces_id=p_replaces,correction_reason=btrim(p_reason) where id=eid;
  update public.shopping_purchases set expense_id=eid where expense_id=p_replaces;
  insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(gid,actor,'expense_corrected',eid,jsonb_build_object('replaces',p_replaces,'reason',btrim(p_reason)));
 end if;
 if p_purchase is not null then update public.shopping_purchases set expense_id=eid where id=p_purchase;end if;
 return private.operation_done(gid,request,body,eid);
end $$;

create function private.void_expense(p_group uuid,p_expense uuid,p_version integer,p_reason text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('void_expense',p_group,p_expense,p_version,p_reason);prior uuid;actor uuid;old public.expenses;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 select * into old from public.expenses where id=p_expense and group_id=p_group for update;
 if not found or (old.created_by<>actor and not private.is_organiser(p_group)) then raise exception 'forbidden' using errcode='42501';end if;
 if old.version<>p_version or p_version is null or old.status<>'posted' then raise exception 'stale_version';end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'reason_required';end if;
 if exists(select 1 from public.expense_refunds where expense_id=p_expense and status='posted') then raise exception 'has_refunds';end if;
 update public.expenses set status='voided',version=version+1,correction_reason=btrim(p_reason) where id=p_expense;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'expense_voided',p_expense,jsonb_build_object('reason',btrim(p_reason)));
 return private.operation_done(p_group,p_request,body,p_expense);
end $$;

create function private.record_payment(p_group uuid,p_recipient uuid,p_amount bigint,p_date date,p_note text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('payment',p_group,p_recipient,p_amount,p_date,p_note);prior uuid;actor uuid;pid uuid;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 perform 1 from public.group_members where group_id=p_group and user_id=p_recipient and status='active' and user_id<>actor for share;
 if not found then raise exception 'invalid_payment';end if;
 insert into public.payments(group_id,sender_id,recipient_id,amount_cents,occurred_on,note) values(p_group,actor,p_recipient,p_amount,p_date,btrim(coalesce(p_note,''))) returning id into pid;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'payment_recorded',pid,jsonb_build_object('amount_cents',p_amount));
 return private.operation_done(p_group,p_request,body,pid);
end $$;

create function private.payment_action(p_group uuid,p_payment uuid,p_action text,p_version integer,p_reason text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('payment_action',p_group,p_payment,p_action,p_version,p_reason);prior uuid;actor uuid;pay public.payments;next_status text;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 select * into pay from public.payments where id=p_payment and group_id=p_group for update;
 if not found then raise exception 'invalid_payment';end if;
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

-- Existing 0.2 request receipts remain valid after archive or membership removal.
create or replace function private.create_expense(p_group uuid,p_request uuid,p_description text,p_amount bigint,p_payer uuid,
  p_people uuid[],p_mode text,p_exact jsonb,p_date date,p_category text,p_note text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.require_user(); eid uuid; person uuid; people uuid[]; n integer; i integer:=0;
  share bigint; total bigint:=0; body_hash text; prior public.operation_requests;
begin
  if p_request is null then raise exception 'invalid_request'; end if;
  body_hash:=encode(sha256(convert_to(jsonb_build_array(p_group,p_description,p_amount,p_payer,p_people,p_mode,p_exact,p_date,p_category,p_note)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor::text||p_request::text,0));
  select * into prior from public.operation_requests where actor_id=actor and request_id=p_request;
  if found then
    if prior.payload_hash<>body_hash then raise exception 'idempotency_conflict'; end if;
    return prior.result_id;
  end if;
  perform private.require_member(p_group);
  if p_amount is null or p_amount<1 or p_amount>100000000 then raise exception 'invalid_amount'; end if;
  if p_people is null or cardinality(p_people)=0 or cardinality(p_people)>100 then raise exception 'invalid_split: choose people'; end if;
  select array_agg(distinct u order by u) into people from unnest(p_people) u;
  n:=cardinality(people);
  if n<>cardinality(p_people) or array_position(people,null) is not null then raise exception 'invalid_split: duplicate or missing person'; end if;
  perform 1 from public.group_members where group_id=p_group and user_id=p_payer and status='active' for share;
  if not found then raise exception 'invalid_payer'; end if;
  perform 1 from public.group_members where group_id=p_group and user_id=any(people) and status='active' for share;
  if (select count(*) from public.group_members where group_id=p_group and user_id=any(people) and status='active')<>n then raise exception 'invalid_split: invalid member'; end if;
  if p_mode not in ('equal','exact') or p_mode is null then raise exception 'invalid_split_mode'; end if;
  if p_mode='exact' and (p_exact is null or jsonb_typeof(p_exact)<>'object') then raise exception 'invalid_split'; end if;
  if p_mode='exact' and (select count(*) from jsonb_object_keys(p_exact))<>n then raise exception 'invalid_split'; end if;
  insert into public.expenses(group_id,description,amount_cents,cash_actor_id,split_mode,category,occurred_on,note,created_by)
    values(p_group,btrim(p_description),p_amount,p_payer,p_mode,p_category,p_date,btrim(coalesce(p_note,'')),actor) returning id into eid;
  foreach person in array people loop
    if p_mode='equal' then share:=p_amount/n + case when i < p_amount%n then 1 else 0 end;
    else
      if not p_exact ? person::text or (p_exact->>person::text) is null or (p_exact->>person::text) !~ '^[0-9]{1,9}$' then raise exception 'invalid_split'; end if;
      share:=(p_exact->>person::text)::bigint;
    end if;
    total:=total+share;
    insert into public.expense_shares(group_id,expense_id,user_id,share_cents) values(p_group,eid,person,share);
    i:=i+1;
  end loop;
  if total<>p_amount then raise exception 'invalid_split: shares must equal amount'; end if;
  insert into public.activity_log(group_id,actor_id,action,entity_id,after_data)
    values(p_group,actor,'expense_created',eid,jsonb_build_object('amount_cents',p_amount,'people',people));
  insert into public.operation_requests(actor_id,request_id,group_id,payload_hash,result_id) values(actor,p_request,p_group,body_hash,eid);
  return eid;
end $$;

create function private.refund_expense(p_group uuid,p_expense uuid,p_amount bigint,p_reason text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('refund',p_group,p_expense,p_amount,p_reason);prior uuid;actor uuid;old public.expenses;left_cents bigint;rid uuid;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 select * into old from public.expenses where id=p_expense and group_id=p_group for update;
 if not found or (old.created_by<>actor and not private.is_organiser(p_group)) then raise exception 'forbidden' using errcode='42501';end if;
 if old.status<>'posted' then raise exception 'invalid_refund';end if;
 select old.amount_cents-coalesce(sum(amount_cents),0) into left_cents from public.expense_refunds where expense_id=p_expense and status='posted';
 if p_amount is null or p_amount<1 or p_amount>left_cents then raise exception 'invalid_refund';end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'reason_required';end if;
 insert into public.expense_refunds(group_id,expense_id,amount_cents,reason,created_by) values(p_group,p_expense,p_amount,btrim(p_reason),actor) returning id into rid;
 -- Allocate against each person's remaining refundable share using largest remainders.
 with remaining as (
  select s.user_id,s.share_cents-coalesce((select sum(rs.share_cents) from public.refund_shares rs join public.expense_refunds r on r.id=rs.refund_id where r.expense_id=p_expense and r.status='posted' and rs.user_id=s.user_id),0)::bigint as cents
  from public.expense_shares s where s.expense_id=p_expense
 ),allocation as (
  select user_id,(cents*p_amount)/left_cents as base,(cents*p_amount)%left_cents as remainder from remaining
 ),ranked as (
  select *,row_number() over(order by remainder desc,user_id) as rank,sum(base) over() as allocated from allocation
 )
 insert into public.refund_shares(group_id,refund_id,user_id,share_cents)
 select p_group,rid,user_id,base+case when rank<=p_amount-allocated then 1 else 0 end from ranked;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'refund_recorded',rid,jsonb_build_object('expense',p_expense,'amount_cents',p_amount,'reason',p_reason));
 return private.operation_done(p_group,p_request,body,rid);
end $$;
create function private.void_refund(p_group uuid,p_refund uuid,p_reason text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('void_refund',p_group,p_refund,p_reason);prior uuid;actor uuid;ref public.expense_refunds;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 select * into ref from public.expense_refunds where id=p_refund and group_id=p_group;
 if not found or (ref.created_by<>actor and not private.is_organiser(p_group)) then raise exception 'forbidden' using errcode='42501';end if;
 -- Lock the expense first, consistently with creating a refund or correcting a charge.
 perform 1 from public.expenses where id=ref.expense_id for update;
 select * into ref from public.expense_refunds where id=p_refund for update;
 if ref.status<>'posted' then raise exception 'invalid_action';end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'reason_required';end if;
 update public.expense_refunds set status='voided' where id=p_refund;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'refund_voided',p_refund,jsonb_build_object('reason',p_reason));
 return private.operation_done(p_group,p_request,body,p_refund);
end $$;

create function private.add_shopping_item(p_group uuid,p_name text,p_quantity numeric,p_unit text,p_note text,p_urgent boolean,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('shopping_add',p_group,p_name,p_quantity,p_unit,p_note,p_urgent);prior uuid;actor uuid;sid uuid;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 if p_quantity is null or p_quantity<=0 or p_quantity>100000 or p_quantity<>round(p_quantity,3) then raise exception 'invalid_quantity';end if;
 begin
  insert into public.shopping_items(group_id,name,quantity,remaining,unit,note,urgent,created_by)
  values(p_group,btrim(p_name),p_quantity,p_quantity,coalesce(nullif(btrim(p_unit),''),'items'),btrim(coalesce(p_note,'')),coalesce(p_urgent,false),actor) returning id into sid;
 exception when unique_violation then raise exception 'already_needed';end;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'shopping_added',sid,jsonb_build_object('name',btrim(p_name)));
 return private.operation_done(p_group,p_request,body,sid);
end $$;

create function private.shopping_action(p_group uuid,p_item uuid,p_action text,p_quantity numeric,p_version integer,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('shopping_action',p_group,p_item,p_action,p_quantity,p_version);prior uuid;actor uuid;item public.shopping_items;result uuid:=p_item;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 select * into item from public.shopping_items where id=p_item and group_id=p_group for update;
 if not found then raise exception 'invalid_action';end if;
 if p_version is null or item.version<>p_version then raise exception 'stale_version';end if;
 if item.status<>'needed' then raise exception 'invalid_action';end if;
 if p_action='claim' then
  if item.claimed_by is not null and item.claimed_by<>actor then raise exception 'item_claimed';end if;
  update public.shopping_items set claimed_by=actor,version=version+1 where id=p_item;
 elsif p_action='release' then
  if item.claimed_by<>actor and not private.is_organiser(p_group) then raise exception 'forbidden' using errcode='42501';end if;
  update public.shopping_items set claimed_by=null,version=version+1 where id=p_item;
 elsif p_action='buy' then
  if item.claimed_by is not null and item.claimed_by<>actor then raise exception 'item_claimed';end if;
  if p_quantity is null or p_quantity<=0 or p_quantity>item.remaining or p_quantity<>round(p_quantity,3) then raise exception 'invalid_quantity';end if;
  insert into public.shopping_purchases(group_id,item_id,quantity,created_by) values(p_group,p_item,p_quantity,actor) returning id into result;
  update public.shopping_items set remaining=remaining-p_quantity,status=case when remaining=p_quantity then 'bought' else 'needed' end,claimed_by=null,version=version+1 where id=p_item;
 elsif p_action='remove' then
  if item.created_by<>actor and not private.is_organiser(p_group) then raise exception 'forbidden' using errcode='42501';end if;
  update public.shopping_items set status='removed',claimed_by=null,version=version+1 where id=p_item;
 else raise exception 'invalid_action';end if;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,'shopping_'||p_action,result,jsonb_build_object('name',item.name,'quantity',p_quantity));
 return private.operation_done(p_group,p_request,body,result);
end $$;

create function private.undo_purchase(p_group uuid,p_purchase uuid,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('undo_purchase',p_group,p_purchase);prior uuid;actor uuid;purchase public.shopping_purchases;item public.shopping_items;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_member(p_group);
 select * into purchase from public.shopping_purchases where id=p_purchase and group_id=p_group for update;
 if not found or purchase.undone_at is not null then raise exception 'invalid_action';end if;
 if purchase.created_by<>actor and not private.is_organiser(p_group) then raise exception 'forbidden' using errcode='42501';end if;
 if purchase.expense_id is not null and exists(select 1 from public.expenses where id=purchase.expense_id and status='posted') then raise exception 'purchase_linked';end if;
 select * into item from public.shopping_items where id=purchase.item_id for update;
 if exists(select 1 from public.shopping_items where group_id=p_group and status='needed' and id<>item.id and lower(btrim(name))=lower(btrim(item.name)) and lower(btrim(unit))=lower(btrim(item.unit))) then raise exception 'already_needed';end if;
 update public.shopping_items set remaining=remaining+purchase.quantity,status='needed',version=version+1 where id=item.id;
 update public.shopping_purchases set undone_at=now() where id=p_purchase;
 insert into public.activity_log(group_id,actor_id,action,entity_id) values(p_group,actor,'purchase_undone',p_purchase);
 return private.operation_done(p_group,p_request,body,p_purchase);
end $$;

create function private.group_action(p_group uuid,p_action text,p_target uuid,p_value text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('group_action',p_group,p_action,p_target,p_value);prior uuid;actor uuid;g public.groups;target public.group_members;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_user();
 -- Lock group exclusively for changes, including reopening an archived group.
 select * into g from public.groups where id=p_group for update;
 if not found or not private.is_organiser(p_group) then raise exception 'forbidden' using errcode='42501';end if;
 if p_action='rename' then update public.groups set name=btrim(p_value) where id=p_group;
 elsif p_action in ('archive','reopen') then
  update public.groups set archived_at=case when p_action='archive' then now() else null end where id=p_group;
 elsif p_action='add_trip_member' then
  if g.kind<>'trip' or g.archived_at is not null then raise exception 'invalid_action';end if;
  perform 1 from public.group_members where group_id=g.parent_household_id and user_id=p_target and status='active' for share;
  if not found then raise exception 'trip_member_must_belong_to_household';end if;
  insert into public.group_members(group_id,user_id,role) values(p_group,p_target,'member') on conflict(group_id,user_id) do update set status='active',left_at=null;
 elsif p_action in ('remove_member','make_organiser') then
  select * into target from public.group_members where group_id=p_group and user_id=p_target and status='active' for update;
  if not found then raise exception 'invalid_action';end if;
  if p_action='make_organiser' then update public.group_members set role='organiser' where group_id=p_group and user_id=p_target;
  else
   if target.role='organiser' and (select count(*) from public.group_members where group_id=p_group and role='organiser' and status='active')<=1 then raise exception 'last_organiser';end if;
   if g.kind='household' and exists(select 1 from public.groups tr join public.group_members m on m.group_id=tr.id where tr.parent_household_id=p_group and m.user_id=p_target and m.role='organiser' and m.status='active' and not exists(select 1 from public.group_members other where other.group_id=tr.id and other.role='organiser' and other.status='active' and other.user_id<>p_target)) then raise exception 'last_organiser: assign another trip organiser first';end if;
   update public.group_members set status='revoked',left_at=now() where user_id=p_target and (group_id=p_group or (g.kind='household' and group_id in(select id from public.groups where parent_household_id=p_group)));
   update public.shopping_items set claimed_by=null,version=version+1 where claimed_by=p_target and (group_id=p_group or (g.kind='household' and group_id in(select id from public.groups where parent_household_id=p_group)));
  end if;
 elsif p_action='revoke_invitation' then
  update public.invitations set revoked_at=now() where id=p_target and group_id=p_group and used_at is null;
  if not found then raise exception 'invalid_invitation';end if;
 else raise exception 'invalid_action';end if;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,p_action,coalesce(p_target,p_group),jsonb_build_object('value',p_value));
 return private.operation_done(p_group,p_request,body,p_group);
end $$;
create function private.household_state(p_group uuid,p_limit integer) returns jsonb
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
 'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id,'name',p.display_name,'role',m.role,'status',m.status) order by p.display_name) from public.group_members m join public.profiles p on p.id=m.user_id where m.group_id=p_group),'[]'::jsonb),
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
create or replace function private.get_group_snapshot(p_group uuid) returns jsonb
language sql security definer set search_path='' as $$select private.household_state(p_group,10000)$$;

-- Public wrappers expose only validated operations.
create function public.get_household_state(p_group uuid,p_limit integer default 50) returns jsonb
language sql security invoker set search_path='' as $$select private.household_state(p_group,p_limit)$$;
create function public.create_space(p_name text,p_kind text,p_parent uuid,p_people uuid[],p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.create_space(p_name,p_kind,p_parent,p_people,p_request)$$;
create function public.save_expense(p_input jsonb,p_replaces uuid default null,p_version integer default null,p_reason text default '',p_purchase uuid default null) returns uuid
language sql security invoker set search_path='' as $$select private.save_expense(p_input,p_replaces,p_version,p_reason,p_purchase)$$;
create function public.void_expense(p_group uuid,p_expense uuid,p_version integer,p_reason text,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.void_expense(p_group,p_expense,p_version,p_reason,p_request)$$;
create function public.record_payment(p_group uuid,p_recipient uuid,p_amount bigint,p_date date,p_note text,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.record_payment(p_group,p_recipient,p_amount,p_date,p_note,p_request)$$;
create function public.payment_action(p_group uuid,p_payment uuid,p_action text,p_version integer,p_reason text,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.payment_action(p_group,p_payment,p_action,p_version,p_reason,p_request)$$;
create function public.refund_expense(p_group uuid,p_expense uuid,p_amount bigint,p_reason text,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.refund_expense(p_group,p_expense,p_amount,p_reason,p_request)$$;
create function public.void_refund(p_group uuid,p_refund uuid,p_reason text,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.void_refund(p_group,p_refund,p_reason,p_request)$$;
create function public.add_shopping_item(p_group uuid,p_name text,p_quantity numeric,p_unit text,p_note text,p_urgent boolean,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.add_shopping_item(p_group,p_name,p_quantity,p_unit,p_note,p_urgent,p_request)$$;
create function public.shopping_action(p_group uuid,p_item uuid,p_action text,p_quantity numeric,p_version integer,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.shopping_action(p_group,p_item,p_action,p_quantity,p_version,p_request)$$;
create function public.undo_purchase(p_group uuid,p_purchase uuid,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.undo_purchase(p_group,p_purchase,p_request)$$;
create function public.group_action(p_group uuid,p_action text,p_target uuid,p_value text,p_request uuid) returns uuid
language sql security invoker set search_path='' as $$select private.group_action(p_group,p_action,p_target,p_value,p_request)$$;

-- Apply matching policies and grants explicitly rather than relying on dashboard defaults.
do $$declare table_name text; signature text;begin
 foreach table_name in array array['shopping_items','shopping_purchases','payments','expense_refunds','refund_shares'] loop
  execute format('alter table public.%I enable row level security',table_name);
  execute format('revoke all on public.%I from public,anon,authenticated',table_name);
  execute format('grant select on public.%I to authenticated',table_name);
  execute format('create policy member_read on public.%I for select to authenticated using(private.is_member(group_id))',table_name);
 end loop;
 foreach signature in array array[
 'create_space(text,text,uuid,uuid[],uuid)','save_expense(jsonb,uuid,integer,text,uuid)',
 'void_expense(uuid,uuid,integer,text,uuid)','record_payment(uuid,uuid,bigint,date,text,uuid)',
 'payment_action(uuid,uuid,text,integer,text,uuid)','refund_expense(uuid,uuid,bigint,text,uuid)',
 'void_refund(uuid,uuid,text,uuid)','add_shopping_item(uuid,text,numeric,text,text,boolean,uuid)',
 'shopping_action(uuid,uuid,text,numeric,integer,uuid)','undo_purchase(uuid,uuid,uuid)','group_action(uuid,text,uuid,text,uuid)'
 ] loop
  execute 'revoke all on function private.'||signature||' from public,anon,authenticated';
  execute 'grant execute on function private.'||signature||' to authenticated';
  execute 'revoke all on function public.'||signature||' from public,anon,authenticated';
  execute 'grant execute on function public.'||signature||' to authenticated';
 end loop;
end $$;
revoke all on function private.operation_replay(uuid,jsonb),private.operation_done(uuid,uuid,jsonb,uuid),private.is_organiser(uuid) from public,anon,authenticated;
revoke all on function private.household_state(uuid,integer),public.get_household_state(uuid,integer) from public,anon,authenticated;
grant execute on function private.household_state(uuid,integer),public.get_household_state(uuid,integer) to authenticated;

-- A local test database may not have the hosted Realtime publication.
do $$declare t text;begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach t in array array['groups','shopping_items','shopping_purchases','payments','expense_refunds','refund_shares'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
    execute format('alter publication supabase_realtime add table public.%I',t);
   end if;
  end loop;
 end if;
end $$;
commit;

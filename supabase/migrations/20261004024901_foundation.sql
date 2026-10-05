-- Foundation only: Google identities, groups, invitations, immutable charges and balances.
-- Later migrations add corrections, refunds, repayments, shopping and receipts.
begin;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('household','trip')),
  parent_household_id uuid references public.groups(id),
  currency text not null default 'AUD' check (currency = 'AUD'),
  timezone text not null default 'Australia/Melbourne',
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check ((kind = 'household' and parent_household_id is null) or (kind = 'trip' and parent_household_id is not null))
);
create table public.group_members (
  group_id uuid not null references public.groups(id),
  user_id uuid not null references public.profiles(id),
  role text not null check (role in ('organiser','member')),
  status text not null default 'active' check (status in ('active','revoked')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (group_id,user_id)
);
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id),
  intended_email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by uuid references public.profiles(id),
  revoked_at timestamptz
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id),
  description text not null check (length(btrim(description)) between 1 and 120),
  amount_cents bigint not null check (amount_cents between 1 and 100000000),
  cash_actor_id uuid not null,
  split_mode text not null check (split_mode in ('equal','exact')),
  category text not null check (category in ('groceries','takeaway','household','travel','other')),
  occurred_on date not null,
  note text not null default '' check (length(note) <= 1000),
  status text not null default 'posted' check (status in ('posted','voided')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  version integer not null default 1,
  unique (group_id,id),
  foreign key (group_id,cash_actor_id) references public.group_members(group_id,user_id)
);
create table public.expense_shares (
  group_id uuid not null,
  expense_id uuid not null,
  user_id uuid not null,
  share_cents bigint not null check (share_cents >= 0),
  primary key (expense_id,user_id),
  foreign key (group_id,expense_id) references public.expenses(group_id,id),
  foreign key (group_id,user_id) references public.group_members(group_id,user_id)
);
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id),
  actor_id uuid not null references public.profiles(id),
  action text not null,
  entity_id uuid not null,
  after_data jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create table public.operation_requests (
  actor_id uuid not null references public.profiles(id),
  request_id uuid not null,
  group_id uuid not null references public.groups(id),
  payload_hash text not null,
  result_id uuid not null,
  completed_at timestamptz not null default now(),
  primary key(actor_id,request_id)
);
create index members_user on public.group_members(user_id,status);
create index expenses_group_date on public.expenses(group_id,occurred_on desc,id);
create index shares_group on public.expense_shares(group_id,expense_id);
create index activity_group on public.activity_log(group_id,occurred_at desc);

create function private.on_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,display_name) values (new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),nullif(split_part(new.email,'@',1),''),'Flatmate'),80));
  return new;
end $$;
create trigger our_place_new_user after insert on auth.users for each row execute function private.on_new_user();
insert into public.profiles(id,display_name)
  select id,left(coalesce(nullif(btrim(raw_user_meta_data->>'full_name'),''),nullif(split_part(email,'@',1),''),'Flatmate'),80)
  from auth.users on conflict(id) do nothing;

create function private.require_user() returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not exists(select 1 from auth.users where id=actor and email_confirmed_at is not null
    and raw_app_meta_data->'providers' @> '["google"]'::jsonb) then
    raise exception 'unauthenticated: sign in with a verified Google account' using errcode='28000';
  end if;
  return actor;
end $$;
create function private.is_member(target uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.group_members where group_id=target and user_id=auth.uid() and status='active')
$$;
create function private.can_read_profile(target uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select target=auth.uid() or exists(select 1 from public.group_members me join public.group_members other using(group_id)
    where me.user_id=auth.uid() and other.user_id=target and me.status='active')
$$;
create function private.require_member(target uuid,organiser boolean default false) returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_user();
begin
  perform 1 from public.group_members m join public.groups g on g.id=m.group_id
    where m.group_id=target and m.user_id=actor and m.status='active' and g.archived_at is null
    and (not organiser or m.role='organiser') for share of m,g;
  if not found then raise exception 'forbidden: group access unavailable' using errcode='42501'; end if;
  return actor;
end $$;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.invitations enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_shares enable row level security;
alter table public.activity_log enable row level security;
alter table public.operation_requests enable row level security;
create policy profiles_read on public.profiles for select to authenticated using(private.can_read_profile(id));
create policy groups_read on public.groups for select to authenticated using(private.is_member(id));
create policy members_read on public.group_members for select to authenticated using(private.is_member(group_id));
create policy expenses_read on public.expenses for select to authenticated using(private.is_member(group_id));
create policy shares_read on public.expense_shares for select to authenticated using(private.is_member(group_id));
create policy activity_read on public.activity_log for select to authenticated using(private.is_member(group_id));
revoke all on public.profiles,public.groups,public.group_members,public.invitations,public.expenses,public.expense_shares,public.activity_log,public.operation_requests from anon,authenticated;
grant select on public.profiles,public.groups,public.group_members,public.expenses,public.expense_shares,public.activity_log to authenticated;

create function private.create_group(p_name text,p_kind text default 'household',p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_user(); gid uuid;
begin
  if p_kind='trip' then
    perform private.require_member(p_parent);
    if not exists(select 1 from public.groups where id=p_parent and kind='household') then raise exception 'invalid_parent'; end if;
  end if;
  insert into public.groups(name,kind,parent_household_id,created_by) values(btrim(p_name),p_kind,p_parent,actor) returning id into gid;
  insert into public.group_members(group_id,user_id,role) values(gid,actor,'organiser');
  insert into public.activity_log(group_id,actor_id,action,entity_id) values(gid,actor,'group_created',gid);
  return gid;
end $$;

create function private.create_invitation(p_group uuid,p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_member(p_group,true); token text; address text := lower(btrim(p_email));
begin
  if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_email'; end if;
  -- Foundation trips are limited to current household members.
  if exists(select 1 from public.groups where id=p_group and kind='trip') and not exists(
    select 1 from public.groups g join public.group_members m on m.group_id=g.parent_household_id
    join auth.users u on u.id=m.user_id where g.id=p_group and m.status='active' and lower(u.email)=address
  ) then raise exception 'trip_member_must_belong_to_household'; end if;
  update public.invitations set revoked_at=now() where group_id=p_group and intended_email=address and used_at is null and revoked_at is null;
  token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into public.invitations(group_id,intended_email,token_hash,expires_at,created_by)
    values(p_group,address,encode(sha256(convert_to(token,'UTF8')),'hex'),now()+interval '7 days',actor);
  return token;
end $$;
create function private.accept_invitation(p_token text) returns uuid
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
  if exists(select 1 from public.groups where id=inv.group_id and kind='trip') and not exists(
    select 1 from public.groups g join public.group_members m on m.group_id=g.parent_household_id
    where g.id=inv.group_id and m.user_id=actor and m.status='active'
  ) then raise exception 'trip_member_must_belong_to_household'; end if;
  insert into public.group_members(group_id,user_id,role) values(inv.group_id,actor,'member')
    on conflict(group_id,user_id) do update set status='active',left_at=null,joined_at=now();
  update public.invitations set used_at=now(),used_by=actor where id=inv.id;
  insert into public.activity_log(group_id,actor_id,action,entity_id) values(inv.group_id,actor,'member_joined',actor);
  return inv.group_id;
end $$;

create function private.check_share_total() returns trigger language plpgsql security definer set search_path = '' as $$
declare eid uuid; total bigint; expected bigint; count_shares integer;
begin
  if tg_table_name='expenses' then eid:=new.id; else eid:=coalesce(new.expense_id,old.expense_id); end if;
  select amount_cents into expected from public.expenses where id=eid;
  if found then
    select coalesce(sum(share_cents),0),count(*) into total,count_shares from public.expense_shares where expense_id=eid;
    if count_shares=0 or total<>expected then raise exception 'invalid_split: shares must equal amount'; end if;
  end if;
  return null;
end $$;
create constraint trigger expense_total after insert or update on public.expenses deferrable initially deferred for each row execute function private.check_share_total();
create constraint trigger share_total after insert or update or delete on public.expense_shares deferrable initially deferred for each row execute function private.check_share_total();

create function private.create_expense(p_group uuid,p_request uuid,p_description text,p_amount bigint,p_payer uuid,
  p_people uuid[],p_mode text,p_exact jsonb,p_date date,p_category text,p_note text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.require_member(p_group); eid uuid; person uuid; people uuid[]; n integer; i integer:=0;
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

create function private.get_group_snapshot(p_group uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_user();
  if not private.is_member(p_group) then raise exception 'forbidden' using errcode='42501'; end if;
  return jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id,'name',p.display_name,'role',m.role,'status',m.status) order by p.display_name)
      from public.group_members m join public.profiles p on p.id=m.user_id where m.group_id=p_group),'[]'::jsonb),
    'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_on desc,e.created_at desc) from public.expenses e where e.group_id=p_group),'[]'::jsonb),
    'shares',coalesce((select jsonb_agg(to_jsonb(s)) from public.expense_shares s where s.group_id=p_group),'[]'::jsonb),
    'balances',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'cents',
      coalesce((select sum(e.amount_cents) from public.expenses e where e.group_id=p_group and e.cash_actor_id=m.user_id and e.status='posted'),0)
      -coalesce((select sum(s.share_cents) from public.expense_shares s join public.expenses e on e.id=s.expense_id where s.group_id=p_group and s.user_id=m.user_id and e.status='posted'),0)))
      from public.group_members m where m.group_id=p_group),'[]'::jsonb)
  );
end $$;

create function public.create_group(p_name text,p_kind text default 'household',p_parent uuid default null) returns uuid
language sql security invoker set search_path = '' as $$ select private.create_group(p_name,p_kind,p_parent) $$;
create function public.create_invitation(p_group uuid,p_email text) returns text
language sql security invoker set search_path = '' as $$ select private.create_invitation(p_group,p_email) $$;
create function public.accept_invitation(p_token text) returns uuid
language sql security invoker set search_path = '' as $$ select private.accept_invitation(p_token) $$;
create function public.create_expense(p_group uuid,p_request uuid,p_description text,p_amount bigint,p_payer uuid,
 p_people uuid[],p_mode text,p_exact jsonb,p_date date,p_category text,p_note text default '') returns uuid
language sql security invoker set search_path = '' as $$ select private.create_expense(p_group,p_request,p_description,p_amount,p_payer,p_people,p_mode,p_exact,p_date,p_category,p_note) $$;
create function public.get_group_snapshot(p_group uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.get_group_snapshot(p_group) $$;
revoke all on function private.create_group(text,text,uuid),private.create_invitation(uuid,text),private.accept_invitation(text),private.create_expense(uuid,uuid,text,bigint,uuid,uuid[],text,jsonb,date,text,text),private.get_group_snapshot(uuid) from public,anon,authenticated;
grant execute on function private.create_group(text,text,uuid),private.create_invitation(uuid,text),private.accept_invitation(text),private.create_expense(uuid,uuid,text,bigint,uuid,uuid[],text,jsonb,date,text,text),private.get_group_snapshot(uuid) to authenticated;

revoke all on function private.on_new_user(),private.require_user(),private.is_member(uuid),private.can_read_profile(uuid),private.require_member(uuid,boolean),private.check_share_total() from public,anon,authenticated;
grant execute on function private.is_member(uuid),private.can_read_profile(uuid) to authenticated;
revoke all on function public.create_group(text,text,uuid),public.create_invitation(uuid,text),public.accept_invitation(text),public.create_expense(uuid,uuid,text,bigint,uuid,uuid[],text,jsonb,date,text,text),public.get_group_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.create_group(text,text,uuid),public.create_invitation(uuid,text),public.accept_invitation(text),public.create_expense(uuid,uuid,text,bigint,uuid,uuid[],text,jsonb,date,text,text),public.get_group_snapshot(uuid) to authenticated;

-- Realtime is an invalidation hint; clients also refresh on focus/reconnect.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.expenses,public.group_members;
  end if;
end $$;
commit;

-- Trip invitations grant access to that trip only. Existing memberships and
-- pending invitations retain their parent-household requirement.
begin;

alter table public.group_members add column access_basis text not null default 'household'
 check(access_basis in ('household','direct'));
alter table public.invitations add column access_basis text not null default 'household'
 check(access_basis in ('household','direct'));

create function private.has_group_access(p_user uuid,p_group uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.group_members m join public.groups g on g.id=m.group_id
  where m.group_id=p_group and m.user_id=p_user and m.status='active'
   and (g.kind<>'trip' or m.access_basis='direct' or exists(
    select 1 from public.group_members parent where parent.group_id=g.parent_household_id
     and parent.user_id=p_user and parent.status='active')))
$$;

-- All membership writers take the parent group lock before the trip lock.
-- This also serializes invitations and financial writes with household removal.
create function private.lock_group_scope(p_group uuid) returns public.groups
language plpgsql security definer set search_path='' as $$
declare g public.groups;
begin
 select * into g from public.groups where id=p_group;
 if g.kind='trip' then perform 1 from public.groups where id=g.parent_household_id for share;end if;
 select * into g from public.groups where id=p_group for share;
 return g;
end $$;

create function private.lock_group_member(p_user uuid,p_group uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare membership public.group_members;g public.groups;
begin
 select * into g from public.groups where id=p_group;
 select * into membership from public.group_members where group_id=p_group and user_id=p_user and status='active' for share;
 if not found then return false;end if;
 if g.kind='trip' and membership.access_basis='household' then
  perform 1 from public.group_members where group_id=g.parent_household_id and user_id=p_user and status='active' for share;
  if not found then return false;end if;
 end if;
 return true;
end $$;

revoke all on function private.has_group_access(uuid,uuid),private.lock_group_scope(uuid),private.lock_group_member(uuid,uuid) from public,anon,authenticated;

create or replace function private.is_member(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.has_group_access(auth.uid(),target)
$$;

create or replace function private.require_member(target uuid,organiser boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();g public.groups;
begin
 g:=private.lock_group_scope(target);
 if g.id is null or g.archived_at is not null or not private.lock_group_member(actor,target)
  or (organiser and not exists(select 1 from public.group_members where group_id=target and user_id=actor and role='organiser')) then
  raise exception 'forbidden: group access unavailable' using errcode='42501';
 end if;
 return actor;
end $$;

create or replace function private.create_invitation(p_group uuid,p_email text) returns text
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_member(p_group,true);token text;address text:=lower(btrim(p_email));basis text;
begin
 if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_email';end if;
 -- Reissuing the same address cannot leave two concurrently created links valid.
 perform pg_advisory_xact_lock(hashtextextended('invitation:'||p_group::text||':'||address,0));
 select case when kind='trip' then 'direct' else 'household' end into basis from public.groups where id=p_group;
 update public.invitations set revoked_at=now() where group_id=p_group and intended_email=address and used_at is null and revoked_at is null;
 token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.invitations(group_id,intended_email,token_hash,expires_at,created_by,access_basis)
 values(p_group,address,encode(sha256(convert_to(token,'UTF8')),'hex'),now()+interval '7 days',actor,basis);
 return token;
end $$;

create or replace function private.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();inv public.invitations;address text;target uuid;g public.groups;
begin
 if p_token is null or length(p_token)<>64 then raise exception 'invalid_invitation';end if;
 select lower(email) into address from auth.users where id=actor;
 -- Discover the scope, then acquire locks in the same order as member removal.
 select group_id into target from public.invitations where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if target is null then raise exception 'invalid_invitation';end if;
 -- Membership changes need an exclusive group lock before invitation/member
 -- locks, including when two organisers accept invitations from each other.
 select * into g from public.groups where id=target;
 if g.kind='trip' then perform 1 from public.groups where id=g.parent_household_id for share;end if;
 select * into g from public.groups where id=target for update;
 select * into inv from public.invitations where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
 if not found or inv.intended_email<>address or inv.revoked_at is not null or inv.expires_at<=now() then raise exception 'invalid_invitation';end if;
 if inv.used_at is not null then
  if inv.used_by=actor and private.is_member(inv.group_id) then return inv.group_id;end if;
  raise exception 'invalid_invitation';
 end if;
 if g.id is null or g.archived_at is not null then raise exception 'invalid_invitation';end if;
 if not private.lock_group_member(inv.created_by,inv.group_id) or not exists(
  select 1 from public.group_members where group_id=inv.group_id and user_id=inv.created_by and role='organiser') then raise exception 'invalid_invitation';end if;
 if g.kind='trip' and inv.access_basis='household' then
  perform 1 from public.group_members where group_id=g.parent_household_id and user_id=actor and status='active' for share;
  if not found then raise exception 'trip_member_must_belong_to_household';end if;
 end if;
 insert into public.group_members as existing(group_id,user_id,role,access_basis)
 values(inv.group_id,actor,'member',inv.access_basis)
 on conflict(group_id,user_id) do update set status='active',left_at=null,
  joined_at=case when existing.status='active' then existing.joined_at else now() end,
  role=case when existing.status='active' then existing.role else 'member' end,
  access_basis=case when existing.status='active' then existing.access_basis else excluded.access_basis end;
 update public.invitations set used_at=now(),used_by=actor where id=inv.id;
 insert into public.activity_log(group_id,actor_id,action,entity_id) values(inv.group_id,actor,'member_joined',actor);
 return inv.group_id;
end $$;

create or replace function private.group_action(p_group uuid,p_action text,p_target uuid,p_value text,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare body jsonb:=jsonb_build_array('group_action',p_group,p_action,p_target,p_value);prior uuid;actor uuid;g public.groups;target public.group_members;
begin
 prior:=private.operation_replay(p_request,body);if prior is not null then return prior;end if;actor:=private.require_user();
 -- Parent first: household removal and trip changes cannot pass one another.
 select * into g from public.groups where id=p_group;
 if g.kind='trip' then perform 1 from public.groups where id=g.parent_household_id for share;end if;
 select * into g from public.groups where id=p_group for update;
 if not found or not private.is_organiser(p_group) then raise exception 'forbidden' using errcode='42501';end if;
 if p_action='rename' then update public.groups set name=btrim(p_value) where id=p_group;
 elsif p_action in ('archive','reopen') then
  update public.groups set archived_at=case when p_action='archive' then now() else null end where id=p_group;
 elsif p_action='add_trip_member' then
  if g.kind<>'trip' or g.archived_at is not null then raise exception 'invalid_action';end if;
  -- Only parent members may use the household directory/picker. Guests invite by email.
  if not private.lock_group_member(actor,g.parent_household_id) then raise exception 'forbidden' using errcode='42501';end if;
  perform 1 from public.group_members where group_id=g.parent_household_id and user_id=p_target and status='active' for share;
  if not found then raise exception 'trip_member_must_belong_to_household';end if;
  insert into public.group_members as existing(group_id,user_id,role,access_basis) values(p_group,p_target,'member','household')
  on conflict(group_id,user_id) do update set status='active',left_at=null,
   role=case when existing.status='active' then existing.role else 'member' end,
   access_basis=case when existing.status='active' then existing.access_basis else 'household' end;
 elsif p_action in ('remove_member','make_organiser') then
  select * into target from public.group_members where group_id=p_group and user_id=p_target and status='active' for update;
  if not found then raise exception 'invalid_action';end if;
  if p_action='make_organiser' then update public.group_members set role='organiser' where group_id=p_group and user_id=p_target;
  else
   if target.role='organiser' and (select count(*) from public.group_members where group_id=p_group and role='organiser' and status='active' and private.has_group_access(user_id,p_group))<=1 then raise exception 'last_organiser';end if;
   if g.kind='household' and exists(select 1 from public.groups tr join public.group_members m on m.group_id=tr.id where tr.parent_household_id=p_group and m.user_id=p_target and m.role='organiser' and m.status='active' and not exists(select 1 from public.group_members other where other.group_id=tr.id and other.role='organiser' and other.status='active' and other.user_id<>p_target and private.has_group_access(other.user_id,tr.id))) then raise exception 'last_organiser: assign another trip organiser first';end if;
   update public.group_members set status='revoked',left_at=now() where user_id=p_target and (group_id=p_group or (g.kind='household' and group_id in(select id from public.groups where parent_household_id=p_group)));
   update public.shopping_items set claimed_by=null,version=version+1 where claimed_by=p_target and (group_id=p_group or (g.kind='household' and group_id in(select id from public.groups where parent_household_id=p_group)));
   -- A pending link cannot restore removed access or survive its inviter's removal.
   update public.invitations set revoked_at=now() where used_at is null and revoked_at is null
    and (intended_email=(select lower(email) from auth.users where id=p_target) or created_by=p_target)
    and (group_id=p_group or (g.kind='household' and group_id in(select id from public.groups where parent_household_id=p_group)));
  end if;
 elsif p_action='revoke_invitation' then
  update public.invitations set revoked_at=now() where id=p_target and group_id=p_group and used_at is null;
  if not found then raise exception 'invalid_invitation';end if;
 else raise exception 'invalid_action';end if;
 insert into public.activity_log(group_id,actor_id,action,entity_id,after_data) values(p_group,actor,p_action,coalesce(p_target,p_group),jsonb_build_object('value',p_value));
 return private.operation_done(p_group,p_request,body,p_group);
end $$;

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
  if not private.lock_group_member(p_payer,p_group) then raise exception 'invalid_payer';end if;
  foreach person in array people loop
    if not private.lock_group_member(person,p_group) then raise exception 'invalid_split: invalid member';end if;
  end loop;
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

-- Optional modules are patched only when already installed. This migration does
-- not install repayment preferences, notifications, or photo storage as a side effect.
-- If an older optional migration is installed later, apply a new compatibility
-- migration afterwards before enabling that feature; it otherwise restores its
-- previous parent-only membership rule.
do $compatibility$
declare definition text;old_check text;new_check text;
begin
 if to_regprocedure('private.can_read_photo(uuid,uuid)') is not null then
  execute $definition$
   create or replace function private.can_read_photo(viewer uuid,owner_id uuid) returns boolean
   language sql stable security definer set search_path='' as $body$
    select viewer=owner_id or exists(select 1 from public.group_members me join public.group_members other using(group_id)
     where me.user_id=viewer and other.user_id=owner_id
      and private.has_group_access(viewer,me.group_id) and private.has_group_access(owner_id,me.group_id))
   $body$
  $definition$;
 end if;
 if to_regprocedure('private.notification_member(uuid,uuid)') is not null then
  execute $definition$
   create or replace function private.notification_member(p_user uuid,p_group uuid) returns boolean
   language sql stable security definer set search_path='' as $body$select private.has_group_access(p_user,p_group)$body$
  $definition$;
 end if;
 if to_regprocedure('private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean)') is not null then
  -- Both supported repayment versions use this validation block. Preserve their
  -- existing settlement/preference semantics, receipt hashes and public signatures.
  definition:=pg_get_functiondef('private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean)'::regprocedure);
  old_check:=$old$ select parent_household_id into parent from public.groups where id=p_group and kind='trip';
 if parent is not null then
  perform 1 from public.group_members where group_id=parent and user_id=p_other and status='active' for share;
  if not found then raise exception 'invalid_payment';end if;
 end if;
 perform 1 from public.group_members where group_id=p_group and user_id=p_other and status='active' for share;
 if not found then raise exception 'invalid_payment';end if;$old$;
  new_check:=$new$ if not private.lock_group_member(p_other,p_group) then raise exception 'invalid_payment';end if;$new$;
  if position(old_check in definition)=0 then raise exception 'unsupported_repayment_definition: review guest membership integration';end if;
  execute replace(definition,old_check,new_check);
 else
  definition:=pg_get_functiondef('private.record_payment(uuid,uuid,bigint,date,text,uuid)'::regprocedure);
  old_check:=$old$ perform 1 from public.group_members where group_id=p_group and user_id=p_recipient and status='active' and user_id<>actor for share;
 if not found then raise exception 'invalid_payment';end if;$old$;
  new_check:=$new$ if p_recipient=actor or not private.lock_group_member(p_recipient,p_group) then raise exception 'invalid_payment';end if;$new$;
  if position(old_check in definition)=0 then raise exception 'unsupported_payment_definition: review guest membership integration';end if;
  execute replace(definition,old_check,new_check);
 end if;
end $compatibility$;

commit;

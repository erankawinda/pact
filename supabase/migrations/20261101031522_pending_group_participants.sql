-- Group ledger identities can exist before an account joins. Access and actor
-- attribution still use verified Auth users; no placeholder accounts are made.
begin;
create table public.group_participants (
 group_id uuid not null references public.groups(id),
 id uuid not null,
 auth_user_id uuid references public.profiles(id),
 display_name text not null check(length(btrim(display_name)) between 1 and 80),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default clock_timestamp(),
 joined_at timestamptz,
 primary key(group_id,id),unique(group_id,auth_user_id),
 check((auth_user_id is null)=(joined_at is null))
);
create index group_participants_auth on public.group_participants(auth_user_id,group_id) where auth_user_id is not null;
create index group_participants_creator on public.group_participants(created_by);
alter table public.group_participants enable row level security;
revoke all on public.group_participants from public,anon,authenticated;
create table private.participant_contacts (
 group_id uuid not null,participant_id uuid not null,email text not null,
 primary key(group_id,participant_id),unique(group_id,email),
 foreign key(group_id,participant_id) references public.group_participants(group_id,id)
);
alter table private.participant_contacts enable row level security;
revoke all on private.participant_contacts from public,anon,authenticated;
insert into public.group_participants(group_id,id,auth_user_id,display_name,created_by,joined_at)
 select m.group_id,m.user_id,m.user_id,p.display_name,m.user_id,m.joined_at
 from public.group_members m join public.profiles p on p.id=m.user_id;
alter table public.invitations add column participant_id uuid;
alter table public.invitations add constraint invitations_participant_fk foreign key(group_id,participant_id) references public.group_participants(group_id,id);
create index invitations_participant on public.invitations(group_id,participant_id) where participant_id is not null;

alter table public.expenses drop constraint expenses_group_id_cash_actor_id_fkey;
alter table public.expenses add constraint expenses_participant_fk foreign key(group_id,cash_actor_id) references public.group_participants(group_id,id);
alter table public.expense_shares drop constraint expense_shares_group_id_user_id_fkey;
alter table public.expense_shares add constraint expense_shares_participant_fk foreign key(group_id,user_id) references public.group_participants(group_id,id);
alter table public.refund_shares drop constraint refund_shares_group_id_user_id_fkey;
alter table public.refund_shares add constraint refund_shares_participant_fk foreign key(group_id,user_id) references public.group_participants(group_id,id);
alter table public.payments drop constraint payments_group_id_sender_id_fkey,drop constraint payments_group_id_recipient_id_fkey;
alter table public.payments add constraint payments_sender_participant_fk foreign key(group_id,sender_id) references public.group_participants(group_id,id),
 add constraint payments_recipient_participant_fk foreign key(group_id,recipient_id) references public.group_participants(group_id,id);

create function private.participant_auth_user(p_group uuid,p_participant uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select auth_user_id from public.group_participants where group_id=p_group and id=p_participant
$$;
create function private.participant_id(p_group uuid,p_person uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select id from public.group_participants where group_id=p_group and (id=p_person or auth_user_id=p_person)
 order by (id=p_person) desc limit 1
$$;
create function private.pending_participant_active(p_group uuid,p_participant uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.invitations i join public.group_participants p on p.group_id=i.group_id and p.id=i.participant_id
  join public.groups g on g.id=i.group_id
  where p.group_id=p_group and p.id=p_participant and p.auth_user_id is null
   and i.used_at is null and i.revoked_at is null and i.expires_at>statement_timestamp() and g.archived_at is null
   and private.has_group_access(i.created_by,p_group)
   and exists(select 1 from public.group_members m where m.group_id=p_group and m.user_id=i.created_by and m.role='organiser'))
$$;
create function private.lock_group_participant(p_person uuid,p_group uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare p public.group_participants;
begin
 select * into p from public.group_participants where group_id=p_group and id=p_person for share;
 if not found then return false;end if;
 if p.auth_user_id is not null then return private.lock_group_member(p.auth_user_id,p_group);end if;
 perform 1 from public.invitations where group_id=p_group and participant_id=p_person and used_at is null and revoked_at is null for share;
 return private.pending_participant_active(p_group,p_person);
end $$;

create function private.ensure_member_participant() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.group_participants where group_id=new.group_id and auth_user_id=new.user_id) then return new;end if;
 if exists(select 1 from private.participant_contacts c join public.group_participants p on p.group_id=c.group_id and p.id=c.participant_id
  join auth.users u on lower(u.email)=c.email where c.group_id=new.group_id and u.id=new.user_id and p.auth_user_id is null) then
  raise exception 'participant_invitation_required: accept the personal invitation to claim existing records';
 end if;
 insert into public.group_participants(group_id,id,auth_user_id,display_name,created_by,joined_at)
 values(new.group_id,new.user_id,new.user_id,(select display_name from public.profiles where id=new.user_id),new.user_id,new.joined_at);
 return new;
end $$;
create trigger ensure_member_participant after insert on public.group_members for each row execute function private.ensure_member_participant();

create function private.attach_pending_invitation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 select p.id into new.participant_id from private.participant_contacts c join public.group_participants p on p.group_id=c.group_id and p.id=c.participant_id
  where c.group_id=new.group_id and c.email=new.intended_email and p.auth_user_id is null;
 return new;
end $$;
create trigger attach_pending_invitation before insert on public.invitations for each row execute function private.attach_pending_invitation();

create function private.add_pending_participant(p_group uuid,p_name text,p_email text,p_request uuid,p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();address text:=lower(btrim(p_email));label text:=btrim(p_name);body jsonb;
 prior uuid;party uuid;inv public.invitations;g public.groups;digest text;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' or label is null or length(label) not between 1 and 80 or label ~ '[[:cntrl:]]'
  or address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_participant';end if;
 digest:=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 body:=jsonb_build_array('pending_participant',p_group,label,address,digest);
 prior:=private.operation_replay(p_request,body);
 if prior is not null then
  perform private.require_member(p_group,true);
  select * into inv from public.invitations where group_id=p_group and token_hash=digest and participant_id=prior;
  if not found or inv.revoked_at is not null or inv.expires_at<=clock_timestamp() or inv.used_at is not null then raise exception 'invitation_replaced: create a new invitation';end if;
  return jsonb_build_object('participant_id',prior,'invitation_id',inv.id,'token',p_token,'expires_at',inv.expires_at);
 end if;
 perform private.require_member(p_group,true);
 perform pg_advisory_xact_lock(hashtextextended('invitation:'||p_group::text||':'||address,0));
 if exists(select 1 from public.group_participants p join auth.users u on u.id=p.auth_user_id where p.group_id=p_group and lower(u.email)=address) then
  raise exception 'participant_already_joined: this person already has group records';
 end if;
 select c.participant_id into party from private.participant_contacts c where c.group_id=p_group and c.email=address;
 if party is null then
  party:=gen_random_uuid();
  insert into public.group_participants(group_id,id,display_name,created_by) values(p_group,party,label,actor);
  insert into private.participant_contacts(group_id,participant_id,email) values(p_group,party,address);
 else
  -- A new request may replace an expired/lost invitation, but never a ledger
  -- identity or historical label. Claiming shows the account's own name.
  perform 1 from public.group_participants where group_id=p_group and id=party and auth_user_id is null for update;
  if not found then raise exception 'participant_already_joined';end if;
 end if;
 update public.invitations set revoked_at=now() where group_id=p_group and intended_email=address and used_at is null and revoked_at is null;
 select * into g from public.groups where id=p_group;
 insert into public.invitations(group_id,intended_email,token_hash,expires_at,created_by,access_basis)
 values(p_group,address,digest,now()+interval '7 days',actor,case when g.kind='trip' then 'direct' else 'household' end) returning * into inv;
 perform private.operation_done(p_group,p_request,body,party);
 insert into public.activity_log(group_id,actor_id,action,entity_id) values(p_group,actor,'participant_invited',party);
 return jsonb_build_object('participant_id',party,'invitation_id',inv.id,'token',p_token,'expires_at',inv.expires_at);
end $$;

create function private.invitation_for_actor(p_token text) returns public.invitations
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();inv public.invitations;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'invalid_invitation';end if;
 select i.* into inv from public.invitations i join auth.users u on u.id=actor and lower(u.email)=i.intended_email
  where i.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if not found or inv.revoked_at is not null or inv.expires_at<=clock_timestamp()
  or (inv.used_at is not null and (inv.used_by<>actor or not private.is_member(inv.group_id)))
  or not exists(select 1 from public.groups where id=inv.group_id and archived_at is null)
  or not private.has_group_access(inv.created_by,inv.group_id)
  or not exists(select 1 from public.group_members where group_id=inv.group_id and user_id=inv.created_by and role='organiser') then raise exception 'invalid_invitation';end if;
 return inv;
end $$;

create function private.get_invitation_preview(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare inv public.invitations:=private.invitation_for_actor(p_token);g public.groups;p public.group_participants;
 paid bigint:=0;shared bigint:=0;counted bigint:=0;summary jsonb;review text;
begin
 select * into g from public.groups where id=inv.group_id;
 select * into p from public.group_participants where group_id=inv.group_id and id=inv.participant_id;
 if p.id is not null then
  select coalesce(sum(e.amount_cents-coalesce((select sum(r.amount_cents) from public.expense_refunds r where r.expense_id=e.id and r.status='posted'),0)),0)
   into paid from public.expenses e where e.group_id=inv.group_id and e.cash_actor_id=p.id and e.status='posted';
  select coalesce(sum(s.share_cents-coalesce((select sum(rs.share_cents) from public.refund_shares rs join public.expense_refunds r on r.id=rs.refund_id where r.expense_id=e.id and rs.user_id=p.id and r.status='posted'),0)),0)
   into shared from public.expense_shares s join public.expenses e on e.id=s.expense_id where s.group_id=inv.group_id and s.user_id=p.id and e.status='posted';
  select count(*) into counted from public.expenses e where e.group_id=inv.group_id and e.status='posted'
   and (e.cash_actor_id=p.id or exists(select 1 from public.expense_shares s where s.expense_id=e.id and s.user_id=p.id));
 end if;
 summary:=jsonb_build_object('group_id',g.id,'group_name',g.name,'group_kind',g.kind,'participant_id',p.id,'invited_name',p.display_name,
  'expense_count',counted,'paid_cents',paid,'share_cents',shared,'net_cents',paid-shared,'already_joined',inv.used_at is not null);
 -- Include record IDs/versions as well as totals, so equal-value corrections
 -- between preview and acceptance also require a fresh review.
 review:=encode(sha256(convert_to((summary||jsonb_build_object('invitation',inv.id,'history',coalesce((
  select jsonb_agg(jsonb_build_array(e.id,e.version,e.status,e.amount_cents,e.description,e.occurred_on) order by e.id)
  from public.expenses e where e.group_id=inv.group_id and (e.cash_actor_id=p.id or exists(select 1 from public.expense_shares s where s.expense_id=e.id and s.user_id=p.id))
 ),'[]'::jsonb),'refunds',coalesce((select jsonb_agg(jsonb_build_array(r.id,r.status,r.amount_cents) order by r.id) from public.expense_refunds r
 where r.group_id=inv.group_id and exists(select 1 from public.expenses e where e.id=r.expense_id and (e.cash_actor_id=p.id or exists(select 1 from public.expense_shares s where s.expense_id=e.id and s.user_id=p.id)))),'[]'::jsonb)))::text,'UTF8')),'hex');
 return summary||jsonb_build_object('review_digest',review);
end $$;

alter function private.accept_invitation(text) rename to accept_invitation_before_participants;
revoke all on function private.accept_invitation_before_participants(text) from public,anon,authenticated;
create function private.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path='' as $$
declare inv public.invitations:=private.invitation_for_actor(p_token);
begin
 if inv.participant_id is not null and inv.used_at is null then raise exception 'invitation_review_required: update Pact to review your invitation';end if;
 return private.accept_invitation_before_participants(p_token);
end $$;
create function private.accept_invitation_v2(p_token text,p_review_digest text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_user();inv public.invitations;g public.groups;preview jsonb;p public.group_participants;result uuid;
begin
 inv:=private.invitation_for_actor(p_token);
 select * into g from public.groups where id=inv.group_id;
 if g.kind='trip' then perform 1 from public.groups where id=g.parent_household_id for share;end if;
 perform 1 from public.groups where id=g.id for update;
 inv:=private.invitation_for_actor(p_token);
 select * into inv from public.invitations where id=inv.id for update;
 if inv.used_at is not null then return private.accept_invitation_before_participants(p_token);end if;
 preview:=private.get_invitation_preview(p_token);
 if p_review_digest is null or preview->>'review_digest'<>p_review_digest then raise exception 'invitation_preview_changed: review the latest records before joining';end if;
 if inv.participant_id is not null then
  select * into p from public.group_participants where group_id=g.id and id=inv.participant_id for update;
  if not found or (p.auth_user_id is not null and p.auth_user_id<>actor)
   or exists(select 1 from public.group_participants where group_id=g.id and auth_user_id=actor and id<>p.id) then
   raise exception 'participant_conflict: an organiser must resolve the separate group records';
  end if;
  update public.group_participants set auth_user_id=actor,joined_at=clock_timestamp() where group_id=g.id and id=p.id;
 end if;
 result:=private.accept_invitation_before_participants(p_token);
 if inv.participant_id is not null then insert into public.activity_log(group_id,actor_id,action,entity_id) values(g.id,actor,'participant_claimed',p.id);end if;
 return result;
end $$;

-- Financial and snapshot compatibility are defined below before granting the
-- new API. All changes commit atomically with these identities.
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
  -- Resolve legacy Auth-ID inputs before writing canonical ledger identities.
  -- The request hash above remains based on the original submitted payload.
  p_payer:=private.participant_id(p_group,p_payer);
  p_people:=array(select private.participant_id(p_group,id) from unnest(p_people) id);
  if p_mode='exact' and jsonb_typeof(p_exact)='object' then
   -- Do not collapse two aliases for one person into a seemingly valid split.
   if (select count(*) from jsonb_object_keys(p_exact))<>cardinality(p_people)
    or exists(select 1 from jsonb_object_keys(p_exact) k where k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'invalid_split';end if;
   select jsonb_object_agg(coalesce(private.participant_id(p_group,key::uuid)::text,key),value) into p_exact from jsonb_each(p_exact);
  end if;
  select array_agg(distinct u order by u) into people from unnest(p_people) u;
  n:=cardinality(people);
  if n<>cardinality(p_people) or array_position(people,null) is not null then raise exception 'invalid_split: duplicate or missing person'; end if;
  if not private.lock_group_participant(p_payer,p_group) then raise exception 'invalid_payer';end if;
  foreach person in array people loop
    if not private.lock_group_participant(person,p_group) then raise exception 'invalid_split: invalid member';end if;
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

create or replace function private.household_state_v4(p_group uuid,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;writable boolean;
begin
 perform private.require_user();if not private.is_member(p_group) then raise exception 'forbidden' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 10000 then raise exception 'invalid_limit';end if;
 select archived_at is null into writable from public.groups where id=p_group;
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
 'schema_version',4,'my_participant_id',private.participant_id(p_group,auth.uid()),
 'members',coalesce((select jsonb_agg(jsonb_build_object('id',party.id,'auth_user_id',party.auth_user_id,'name',coalesce(p.display_name,party.display_name),
  'role',coalesce(m.role,'member'),'status',case when party.auth_user_id is null then case when private.pending_participant_active(p_group,party.id) then 'invited' else 'expired' end
   when private.has_group_access(party.auth_user_id,p_group) then 'active' else 'revoked' end,
  'can_select',writable and case when party.auth_user_id is null then private.pending_participant_active(p_group,party.id) else private.has_group_access(party.auth_user_id,p_group) end,
  'can_repay',writable and party.auth_user_id is not null and private.has_group_access(party.auth_user_id,p_group),
  'require_payment_approval',coalesce((to_jsonb(p)->>'require_payment_approval')::boolean,false)) order by coalesce(p.display_name,party.display_name),party.id)
  from public.group_participants party left join public.profiles p on p.id=party.auth_user_id left join public.group_members m on m.group_id=party.group_id and m.user_id=party.auth_user_id
  where party.group_id=p_group),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_on desc,e.created_at desc,e.id) from recent e),'[]'::jsonb),
 'expense_count',(select count(*) from public.expenses where group_id=p_group),
 'shares',coalesce((select jsonb_agg(to_jsonb(s)) from public.expense_shares s join recent e on e.id=s.expense_id),'[]'::jsonb),
 'balances',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.id,'cents',coalesce(t.cents,0))) from public.group_participants m left join totals t on t.user_id=m.id where m.group_id=p_group),'[]'::jsonb),
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

alter function private.household_state(uuid,integer) rename to household_state_before_participants;
revoke all on function private.household_state_before_participants(uuid,integer) from public,anon,authenticated;
create function private.household_state(p_group uuid,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_user();if not private.is_member(p_group) then raise exception 'forbidden' using errcode='42501';end if;
 if exists(select 1 from public.group_participants where group_id=p_group and (auth_user_id is null or id<>auth_user_id)) then
  raise exception 'client_update_required: refresh Pact to view invited participant records';
 end if;
 return private.household_state_before_participants(p_group,p_limit);
end $$;

-- Endpoints are ledger parties; the recorder always remains an actual Auth user.
alter table public.payments drop constraint if exists payment_recorder_is_participant;
create function private.check_payment_participants() returns trigger
language plpgsql security definer set search_path='' as $$
declare sender_user uuid:=private.participant_auth_user(new.group_id,new.sender_id);
 recipient_user uuid:=private.participant_auth_user(new.group_id,new.recipient_id);recorder uuid:=(to_jsonb(new)->>'recorded_by')::uuid;
begin
 if sender_user is null or recipient_user is null or sender_user=recipient_user
  or (recorder is not null and recorder<>sender_user and recorder<>recipient_user) then raise exception 'invalid_payment: joined participants required';end if;
 return new;
end $$;
create trigger check_payment_participants before insert or update on public.payments for each row execute function private.check_payment_participants();

-- Preserve whichever optional repayment module is installed. Every substitution
-- is checked; an unknown prior definition aborts the migration instead of silently
-- weakening authorization or changing settlement preferences.
do $compatibility$
declare definition text;old text;
begin
 if to_regprocedure('private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean)') is not null then
  definition:=pg_get_functiondef('private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean)'::regprocedure);
  old:='actor uuid:=private.require_member(p_group); sender uuid; recipient uuid;';
  if position(old in definition)=0 then raise exception 'unsupported_repayment_definition';end if;
  definition:=replace(definition,old,'actor uuid:=private.require_member(p_group); actor_party uuid;other_party uuid;other_user uuid; sender uuid; recipient uuid;');
  old:='if not private.lock_group_member(p_other,p_group) then raise exception ''invalid_payment'';end if;';
  if position(old in definition)=0 then raise exception 'unsupported_repayment_definition';end if;
  definition:=replace(definition,old,$new$actor_party:=private.participant_id(p_group,actor);other_party:=private.participant_id(p_group,p_other);
 other_user:=private.participant_auth_user(p_group,other_party);
 if other_user is null or actor_party=other_party or not private.lock_group_member(other_user,p_group) then raise exception 'invalid_payment';end if;$new$);
  old:=$old$sender:=case when p_direction='sent' then actor else p_other end;$old$;
  if position(old in definition)=0 then raise exception 'unsupported_repayment_definition';end if;
  definition:=replace(definition,old,$new$sender:=case when p_direction='sent' then actor_party else other_party end;$new$);
  old:=$old$recipient:=case when p_direction='received' then actor else p_other end;$old$;
  if position(old in definition)=0 then raise exception 'unsupported_repayment_definition';end if;
  definition:=replace(definition,old,$new$recipient:=case when p_direction='received' then actor_party else other_party end;$new$);
  -- This lookup exists only when recipient preferences are installed.
  if exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname='require_payment_approval' and not attisdropped) then
   old:='from public.profiles where id=recipient for share';
   if position(old in definition)=0 then raise exception 'unsupported_repayment_definition';end if;
   definition:=replace(definition,old,'from public.profiles where id=private.participant_auth_user(p_group,recipient) for share');
  end if;
  execute definition;
 else
  definition:=pg_get_functiondef('private.record_payment(uuid,uuid,bigint,date,text,uuid)'::regprocedure);
  old:='if p_recipient=actor or not private.lock_group_member(p_recipient,p_group) then raise exception ''invalid_payment'';end if;';
  if position(old in definition)=0 then raise exception 'unsupported_payment_definition';end if;
  definition:=replace(definition,old,$new$p_recipient:=private.participant_id(p_group,p_recipient);
 if private.participant_auth_user(p_group,p_recipient) is null or private.participant_auth_user(p_group,p_recipient)=actor
  or not private.lock_group_member(private.participant_auth_user(p_group,p_recipient),p_group) then raise exception 'invalid_payment';end if;$new$);
  old:='values(p_group,actor,p_recipient,p_amount';
  if position(old in definition)=0 then raise exception 'unsupported_payment_definition';end if;
  definition:=replace(definition,old,'values(p_group,private.participant_id(p_group,actor),p_recipient,p_amount');
  execute definition;
 end if;
 definition:=pg_get_functiondef('private.payment_action(uuid,uuid,text,integer,text,uuid)'::regprocedure);
 if position('pay.recipient_id=actor' in definition)=0 or position('pay.sender_id=actor' in definition)=0 then raise exception 'unsupported_payment_action';end if;
 definition:=replace(replace(definition,'pay.recipient_id=actor','private.participant_auth_user(p_group,pay.recipient_id)=actor'),
  'pay.sender_id=actor','private.participant_auth_user(p_group,pay.sender_id)=actor');
 execute definition;
end $compatibility$;

create function public.add_pending_participant(p_group uuid,p_name text,p_email text,p_request uuid,p_token text) returns jsonb
language sql security invoker set search_path='' as $$select private.add_pending_participant(p_group,p_name,p_email,p_request,p_token)$$;
create function public.get_invitation_preview(p_token text) returns jsonb
language sql security invoker set search_path='' as $$select private.get_invitation_preview(p_token)$$;
create function public.accept_invitation_v2(p_token text,p_review_digest text) returns uuid
language sql security invoker set search_path='' as $$select private.accept_invitation_v2(p_token,p_review_digest)$$;
create function public.get_group_state_v4(p_group uuid,p_limit integer default 50) returns jsonb
language sql security invoker set search_path='' as $$select private.household_state_v4(p_group,p_limit)$$;

revoke all on function private.participant_auth_user(uuid,uuid),private.participant_id(uuid,uuid),private.pending_participant_active(uuid,uuid),
 private.lock_group_participant(uuid,uuid),private.ensure_member_participant(),private.attach_pending_invitation(),private.invitation_for_actor(text),
 private.check_payment_participants(),private.add_pending_participant(uuid,text,text,uuid,text),public.add_pending_participant(uuid,text,text,uuid,text),
 private.get_invitation_preview(text),public.get_invitation_preview(text),private.accept_invitation(text),private.accept_invitation_v2(text,text),public.accept_invitation_v2(text,text),
 private.household_state(uuid,integer),private.household_state_v4(uuid,integer),public.get_group_state_v4(uuid,integer) from public,anon,authenticated;
grant execute on function private.add_pending_participant(uuid,text,text,uuid,text),public.add_pending_participant(uuid,text,text,uuid,text),
 private.get_invitation_preview(text),public.get_invitation_preview(text),private.accept_invitation(text),private.accept_invitation_v2(text,text),public.accept_invitation_v2(text,text),
 private.household_state(uuid,integer),private.household_state_v4(uuid,integer),public.get_group_state_v4(uuid,integer) to authenticated;
commit;

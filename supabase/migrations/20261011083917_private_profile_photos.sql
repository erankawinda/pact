-- Private, processed profile pictures. Only the authenticated Edge proxy may
-- perform storage or lifecycle operations; household history never grants access.
begin;

create table private.photo_slots (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  state text not null check(state in ('uploading','ready','deleting')),
  generation uuid not null,
  object_path text not null unique,
  source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(object_path = user_id::text || '/' || generation::text || '.jpg')
);
create table private.photo_requests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  action text not null check(action in ('upload','delete')),
  generation uuid not null,
  digest text,
  status text not null default 'pending' check(status in ('pending','complete')),
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
create index photo_requests_recent on private.photo_requests(user_id,created_at desc);
alter table private.photo_slots enable row level security;
alter table private.photo_requests enable row level security;
revoke all on private.photo_slots,private.photo_requests from public,anon,authenticated;

-- Match the application's verified Google requirement using trusted auth data.
create function private.require_photo_user(target uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if target is null or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
  where u.id=target and u.email_confirmed_at is not null
  and u.raw_app_meta_data->'providers' @> '["google"]'::jsonb) then
  raise exception 'photo_unauthenticated: sign in with a verified Google account' using errcode='28000';
 end if;
end $$;

create function private.can_read_photo(viewer uuid,owner_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select viewer=owner_id or exists(
  select 1 from public.group_members me
  join public.group_members other on other.group_id=me.group_id
  join public.groups g on g.id=me.group_id
  where me.user_id=viewer and other.user_id=owner_id
   and me.status='active' and other.status='active'
   and (g.kind<>'trip' or (
    exists(select 1 from public.group_members parent where parent.group_id=g.parent_household_id and parent.user_id=viewer and parent.status='active')
    and exists(select 1 from public.group_members parent where parent.group_id=g.parent_household_id and parent.user_id=owner_id and parent.status='active')
   ))
 )
$$;

create function private.photo_slot_json(slot private.photo_slots) returns jsonb
language sql immutable set search_path='' as $$
 select case when slot.user_id is null then jsonb_build_object('status','empty') else
  jsonb_build_object('status',slot.state,'generation',slot.generation,'object_path',slot.object_path,
   'request_id',slot.generation,'retry_at',slot.lease_expires_at) end
$$;

create function private.profile_photo_action(
 p_user uuid,p_action text,p_request uuid default null,p_version uuid default null,
 p_digest text default null,p_target uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare slot private.photo_slots; prior private.photo_requests; target uuid:=coalesce(p_target,p_user);
begin
 perform private.require_photo_user(p_user);
 if p_action in ('status','read') then
  if p_action='status' and target<>p_user then
   raise exception 'photo_forbidden: only your own photo status is available' using errcode='42501';
  end if;
  if not private.can_read_photo(p_user,target) then
   raise exception 'photo_not_found: photo is unavailable' using errcode='P0002';
  end if;
  select * into slot from private.photo_slots where user_id=target;
  if p_action='read' and (slot.user_id is null or slot.state<>'ready') then
   raise exception 'photo_not_found: photo is unavailable' using errcode='P0002';
  end if;
  return private.photo_slot_json(slot);
 end if;
 if p_target is not null and p_target<>p_user then
  raise exception 'photo_forbidden: you may change only your own photo' using errcode='42501';
 end if;
 -- A profile lock also serialises first insertion when no photo slot exists.
 perform 1 from public.profiles where id=p_user for update;
 select * into slot from private.photo_slots where user_id=p_user;
 if p_action='reserve' then
  if p_request is null or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then
   raise exception 'photo_invalid_request: a request ID and image digest are required' using errcode='22023';
  end if;
  select * into prior from private.photo_requests where user_id=p_user and request_id=p_request;
  if found then
   if prior.action<>'upload' or prior.digest is distinct from p_digest then
    raise exception 'photo_request_conflict: request ID was already used for different data' using errcode='22023';
   end if;
   if slot.user_id is null or slot.generation<>p_request then
    raise exception 'photo_request_finished: this photo request has already ended' using errcode='55000';
   end if;
   if slot.state='uploading' and slot.lease_expires_at<=now() then
    return private.photo_slot_json(slot)||jsonb_build_object('status','cleanup');
   end if;
   if slot.state='deleting' then
    raise exception 'photo_busy: finish removing the current photo first' using errcode='55000';
   end if;
   return private.photo_slot_json(slot)||jsonb_build_object('claimed',false);
  end if;
  if slot.user_id is not null then
   if slot.state='uploading' and slot.lease_expires_at<=now() then
    return private.photo_slot_json(slot)||jsonb_build_object('status','cleanup');
   end if;
   if slot.state='ready' then
    raise exception 'photo_exists: remove your current photo before uploading another' using errcode='55000';
   end if;
   raise exception 'photo_busy: check the current photo operation before trying again' using errcode='55000';
  end if;
  if (select count(*) from private.photo_requests where user_id=p_user and action='upload' and created_at>now()-interval '1 hour')>=20 then
   raise exception 'photo_rate_limit: try uploading again later' using errcode='54000';
  end if;
  insert into private.photo_requests(user_id,request_id,action,generation,digest)
   values(p_user,p_request,'upload',p_request,p_digest);
  insert into private.photo_slots(user_id,state,generation,object_path,source_sha256,lease_expires_at)
   values(p_user,'uploading',p_request,p_user::text||'/'||p_request::text||'.jpg',p_digest,now()+interval '10 minutes') returning * into slot;
  return private.photo_slot_json(slot)||jsonb_build_object('claimed',true);
 elsif p_action='complete' then
  if p_request is null or slot.user_id is null or slot.generation<>p_request or slot.source_sha256 is distinct from p_digest then
   raise exception 'photo_stale_operation: this photo operation is no longer current' using errcode='55000';
  end if;
  if slot.state='ready' then return private.photo_slot_json(slot); end if;
  if slot.state<>'uploading' or slot.lease_expires_at<=now() then
   raise exception 'photo_stale_operation: this photo operation has expired' using errcode='55000';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='profile-photos' and name=slot.object_path
   and metadata->>'mimetype'='image/jpeg' and (metadata->>'size')::bigint between 1 and 262144) then
   raise exception 'photo_storage_missing: uploaded photo could not be verified' using errcode='55000';
  end if;
  update private.photo_slots set state='ready',updated_at=now() where user_id=p_user returning * into slot;
  update private.photo_requests set status='complete' where user_id=p_user and request_id=p_request;
  return private.photo_slot_json(slot);
 elsif p_action='begin_delete' then
  if p_request is null or p_version is null then
   raise exception 'photo_invalid_request: a request ID and photo version are required' using errcode='22023';
  end if;
  select * into prior from private.photo_requests where user_id=p_user and request_id=p_request;
  if found then
   if prior.action<>'delete' or prior.generation<>p_version then
    raise exception 'photo_request_conflict: request ID was already used for a different operation' using errcode='22023';
   end if;
   if prior.status='complete' then return jsonb_build_object('status','empty','deleted_version',p_version); end if;
  end if;
  if slot.user_id is null then
   insert into private.photo_requests(user_id,request_id,action,generation,status) values(p_user,p_request,'delete',p_version,'complete')
    on conflict(user_id,request_id) do update set status='complete';
   return jsonb_build_object('status','empty','deleted_version',p_version);
  end if;
  if slot.generation<>p_version then
   raise exception 'photo_stale_operation: the photo changed; refresh before removing it' using errcode='55000';
  end if;
  if slot.state='uploading' and slot.lease_expires_at>now() then
   raise exception 'photo_busy: the upload is being checked; try again shortly' using errcode='55000';
  end if;
  insert into private.photo_requests(user_id,request_id,action,generation) values(p_user,p_request,'delete',p_version)
   on conflict(user_id,request_id) do nothing;
  update private.photo_slots set state='deleting',updated_at=now() where user_id=p_user returning * into slot;
  return private.photo_slot_json(slot);
 elsif p_action='complete_delete' then
  select * into prior from private.photo_requests where user_id=p_user and request_id=p_request;
  if not found or prior.action<>'delete' or prior.generation is distinct from p_version then
   raise exception 'photo_invalid_request: removal request could not be found' using errcode='22023';
  end if;
  if prior.status='complete' then return jsonb_build_object('status','empty','deleted_version',p_version); end if;
  if slot.user_id is null or slot.generation<>p_version or slot.state<>'deleting' then
   raise exception 'photo_stale_operation: this removal operation is no longer current' using errcode='55000';
  end if;
  if exists(select 1 from storage.objects where bucket_id='profile-photos' and name=slot.object_path) then
   raise exception 'photo_storage_remaining: retry removing the stored photo' using errcode='55000';
  end if;
  delete from private.photo_slots where user_id=p_user and generation=p_version;
  update private.photo_requests set status='complete' where user_id=p_user and generation=p_version;
  return jsonb_build_object('status','empty','deleted_version',p_version);
 elsif p_action='cleanup_upload' then
  if slot.user_id is null then return jsonb_build_object('status','empty');end if;
  if slot.generation is distinct from p_version or slot.state<>'uploading' or slot.lease_expires_at>now() then
   raise exception 'photo_stale_operation: this upload cannot be cleaned up yet' using errcode='55000';
  end if;
  if exists(select 1 from storage.objects where bucket_id='profile-photos' and name=slot.object_path) then
   raise exception 'photo_storage_remaining: retry removing the unfinished photo' using errcode='55000';
  end if;
  delete from private.photo_slots where user_id=p_user and generation=p_version;
  update private.photo_requests set status='complete' where user_id=p_user and request_id=p_version;
  return jsonb_build_object('status','empty');
 end if;
 raise exception 'photo_invalid_request: unsupported photo action' using errcode='22023';
end $$;

create function public.profile_photo_action(
 p_user uuid,p_action text,p_request uuid default null,p_version uuid default null,
 p_digest text default null,p_target uuid default null
) returns jsonb language sql security invoker set search_path='' as $$
 select private.profile_photo_action(p_user,p_action,p_request,p_version,p_digest,p_target)
$$;
revoke all on function private.require_photo_user(uuid),private.can_read_photo(uuid,uuid),private.photo_slot_json(private.photo_slots),
 private.profile_photo_action(uuid,text,uuid,uuid,text,uuid),public.profile_photo_action(uuid,text,uuid,uuid,text,uuid)
 from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.profile_photo_action(uuid,text,uuid,uuid,text,uuid),public.profile_photo_action(uuid,text,uuid,uuid,text,uuid) to service_role;

-- Storage accepts no browser operations. The Edge proxy validates JPEG content,
-- enforces lifecycle/ownership, and sends authenticated responses with no-store.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-photos','profile-photos',false,262144,array['image/jpeg'])
 on conflict(id) do update set public=false,file_size_limit=262144,allowed_mime_types=array['image/jpeg'];

commit;

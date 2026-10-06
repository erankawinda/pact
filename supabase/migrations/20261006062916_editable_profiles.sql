-- A verified Google user may change only their own Pact display name.
-- Keep direct profile writes denied and use the existing private RPC boundary.
begin;

create function private.update_profile(p_display_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_user();
  -- Match JavaScript String.trim() while counting Unicode characters, not bytes.
  name text := btrim(p_display_name,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
begin
  if name is null or char_length(name) not between 1 and 80 then
    raise exception 'invalid_profile: display name must be 1 to 80 characters'
      using errcode = '22023';
  end if;

  update public.profiles set display_name = name where id = actor;
  if not found then
    raise exception 'profile_unavailable: your profile could not be found'
      using errcode = '42501';
  end if;
  return name;
end $$;

create function public.update_profile(p_display_name text) returns text
language sql security invoker set search_path = '' as $$
  select private.update_profile(p_display_name)
$$;

revoke all on function private.update_profile(text), public.update_profile(text)
  from public, anon, authenticated;
grant execute on function private.update_profile(text), public.update_profile(text)
  to authenticated;

commit;

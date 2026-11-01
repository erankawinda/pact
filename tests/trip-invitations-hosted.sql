-- STAGING ONLY. Run the whole file as the development administrator.
-- Fictional users and transactions roll back. This tests SQL roles, not Google
-- OAuth signatures, concurrent connections, photo bytes or native push delivery.
begin;
set local statement_timeout='30s';
set local lock_timeout='3s';
do $$
declare
 a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); guest uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
 home uuid; trip uuid; other_trip uuid; token text; other_token text; invitation_id uuid; expense uuid;
 blocked boolean; snap jsonb; role_count integer;
begin
 insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
 select id,'authenticated','authenticated',id::text||'@example.invalid',now(),
 '{"providers":["google"],"provider":"google"}'::jsonb,jsonb_build_object('full_name',name)
 from (values(a,'QA organiser'),(b,'QA household member'),(outsider,'QA unrelated person')) fixture(id,name);
 perform set_config('request.jwt.claim.sub',a::text,true);
 execute 'set local role authenticated';
 home:=public.create_space('QA guest invitation home','household',null,array[]::uuid[],gen_random_uuid());
 token:=public.create_invitation(home,b::text||'@example.invalid');
 perform set_config('request.jwt.claim.sub',b::text,true);perform public.accept_invitation(token);
 perform set_config('request.jwt.claim.sub',a::text,true);
 trip:=public.create_space('QA chosen event','trip',home,array[b],gen_random_uuid());
 other_trip:=public.create_space('QA unrelated trip','trip',home,array[]::uuid[],gen_random_uuid());
 -- Invitation can be created before the friend has any Pact profile.
 token:=public.create_invitation(trip,guest::text||'@example.invalid');
 execute 'reset role';
 insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
 values(guest,'authenticated','authenticated',guest::text||'@example.invalid',now(),
 '{"providers":["google"],"provider":"google"}','{"full_name":"QA new friend"}');
 execute 'set local role authenticated';
 perform set_config('request.jwt.claim.sub',outsider::text,true);
 blocked:=false;begin perform public.accept_invitation(token);exception when raise_exception then
  if sqlerrm='invalid_invitation' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'QA failure: wrong-account link accepted';end if;
 perform set_config('request.jwt.claim.sub',guest::text,true);
 if exists(select 1 from public.groups) then raise exception 'QA failure: access before acceptance';end if;
 if public.accept_invitation(token)<>trip or public.accept_invitation(token)<>trip then raise exception 'QA failure: acceptance/replay';end if;
 if (select count(*) from public.groups)<>1 or not exists(select 1 from public.groups where id=trip) then raise exception 'QA failure: wrong group scope';end if;
 blocked:=false;begin perform public.get_household_state(home,50);exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'QA failure: household RPC visible';end if;
 blocked:=false;begin perform public.get_group_snapshot(other_trip);exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'QA failure: unrelated trip visible';end if;
 blocked:=false;begin perform public.create_invitation(trip,outsider::text||'@example.invalid');exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'QA failure: member can invite';end if;
 expense:=public.create_expense(trip,gen_random_uuid(),'QA shared event tickets',1000,guest,array[a,guest],'equal',null,current_date,'other','');
 perform public.record_payment(trip,a,100,current_date,'QA fixture only',gen_random_uuid());
 snap:=public.get_household_state(trip,50);
 if jsonb_array_length(snap->'expenses')<>1 or jsonb_array_length(snap->'members')<>3 then raise exception 'QA failure: guest participation';end if;
 if exists(select 1 from public.profiles where id=outsider) then raise exception 'QA failure: unrelated profile visible';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform public.record_payment(trip,guest,200,current_date,'QA fixture only',gen_random_uuid());
 perform public.group_action(trip,'make_organiser',guest,'',gen_random_uuid());
 perform set_config('request.jwt.claim.sub',guest::text,true);
 other_token:=public.create_invitation(trip,outsider::text||'@example.invalid');
 blocked:=false;begin perform public.group_action(trip,'add_trip_member',a,'',gen_random_uuid());exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'QA failure: guest organiser can use parent directory action';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform public.group_action(trip,'remove_member',guest,'',gen_random_uuid());
 perform set_config('request.jwt.claim.sub',guest::text,true);
 blocked:=false;begin perform public.get_group_snapshot(trip);exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'QA failure: revoked guest access';end if;
 blocked:=false;begin perform public.accept_invitation(token);exception when raise_exception then
  if sqlerrm='invalid_invitation' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'QA failure: used link restores revoked membership';end if;
 perform set_config('request.jwt.claim.sub',outsider::text,true);
 blocked:=false;begin perform public.accept_invitation(other_token);exception when raise_exception then
  if sqlerrm='invalid_invitation' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'QA failure: removed inviter still grants access';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 token:=public.create_invitation(trip,guest::text||'@example.invalid');
 perform set_config('request.jwt.claim.sub',guest::text,true);perform public.accept_invitation(token);
 select count(*) into role_count from public.group_members where group_id=trip and user_id=guest and role='member';
 if role_count<>1 then raise exception 'QA failure: rejoin restored organiser role';end if;
 execute 'reset role';
 if exists(select 1 from public.group_members where group_id=home and user_id=guest) then raise exception 'QA failure: implicit household membership';end if;
 if (select count(*) from public.expenses where id=expense)<>1 then raise exception 'QA failure: removal erased ledger';end if;
end $$;
set constraints all immediate;
rollback;
select 'passed' as trip_invitation_database_smoke,
 'All fixtures rolled back; OAuth and device acceptance remain separate' as scope;

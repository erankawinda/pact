-- Run only as the development project's administrator. All fixtures roll back.
-- This exercises database roles; it does not simulate an actual Google login.
begin;
do $$
declare
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  house uuid; trip uuid; invite text; request uuid:=gen_random_uuid(); expense uuid; retried uuid;
  blocked boolean; before_count bigint; snap jsonb; net numeric;
begin
  insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
  values
    (a,'authenticated','authenticated',a::text||'@example.invalid',now(),'{"providers":["google"],"provider":"google"}','{"full_name":"QA organiser"}'),
    (b,'authenticated','authenticated',b::text||'@example.invalid',now(),'{"providers":["google"],"provider":"google"}','{"full_name":"QA flatmate"}'),
    (outsider,'authenticated','authenticated',outsider::text||'@example.invalid',now(),'{"providers":["google"],"provider":"google"}','{"full_name":"QA outsider"}');
  perform set_config('request.jwt.claim.sub',a::text,true);
  execute 'set local role authenticated';
  house:=public.create_group('QA transaction household');
  invite:=public.create_invitation(house,b::text||'@example.invalid');

  perform set_config('request.jwt.claim.sub',outsider::text,true);
  if exists(select 1 from public.groups where id=house) then raise exception 'QA failure: outsider read'; end if;
  blocked:=false;
  begin perform public.get_group_snapshot(house); exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'QA failure: outsider RPC'; end if;
  blocked:=false;
  begin perform public.accept_invitation(invite);
  exception when raise_exception then if sqlerrm='invalid_invitation' then blocked:=true; else raise; end if; end;
  if not blocked then raise exception 'QA failure: wrong invitation email'; end if;

  perform set_config('request.jwt.claim.sub',b::text,true);
  if public.accept_invitation(invite)<>house then raise exception 'QA failure: join'; end if;
  perform set_config('request.jwt.claim.sub',a::text,true);
  expense:=public.create_expense(house,request,'QA groceries',10001,a,array[a,b],'equal',null,current_date,'groceries','');
  retried:=public.create_expense(house,request,'QA groceries',10001,a,array[a,b],'equal',null,current_date,'groceries','');
  if retried<>expense then raise exception 'QA failure: retry'; end if;
  if (select sum(share_cents) from public.expense_shares where expense_id=expense)<>10001 then raise exception 'QA failure: cents total'; end if;
  if (select max(share_cents)-min(share_cents) from public.expense_shares where expense_id=expense)<>1 then raise exception 'QA failure: remainder'; end if;
  perform public.create_expense(house,gen_random_uuid(),'QA solely for B',2500,a,array[b],'equal',null,current_date,'other','');
  select count(*) into before_count from public.expenses where group_id=house;
  if before_count<>2 then raise exception 'QA failure: duplicate expense'; end if;
  blocked:=false;
  begin perform public.create_expense(house,gen_random_uuid(),'QA invalid',100,a,array[a,b],'exact',jsonb_build_object(a::text,40,b::text,59),current_date,'other','');
  exception when raise_exception then if sqlerrm like 'invalid_split:%' then blocked:=true; else raise; end if; end;
  if not blocked or (select count(*) from public.expenses where group_id=house)<>before_count then raise exception 'QA failure: atomic invalid split'; end if;

  trip:=public.create_group('QA private trip','trip',house);
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.groups where id=trip) then raise exception 'QA failure: trip isolation'; end if;
  snap:=public.get_group_snapshot(house);
  if jsonb_array_length(snap->'expenses')<>2 then raise exception 'QA failure: second account record'; end if;
  select sum((v->>'cents')::numeric) into net from jsonb_array_elements(snap->'balances') v;
  if net<>0 then raise exception 'QA failure: zero sum'; end if;
  blocked:=false;
  begin update public.expense_shares set share_cents=0 where expense_id=expense;
  exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'QA failure: direct financial write'; end if;
  execute 'reset role';
end $$;
set constraints all immediate;
rollback;
select 'passed' as database_smoke_test,
  'No fixtures retained; Google OAuth and browser tests remain separate' as scope;

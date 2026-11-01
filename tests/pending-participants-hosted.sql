-- STAGING ONLY. Run the whole file as the development administrator.
-- Every fictional account, identity and financial row rolls back. No provider
-- is contacted: email checks exercise SQL delivery state only. This does not
-- prove OAuth, concurrent connections, mail delivery or native notifications.
begin;
set local statement_timeout='30s';
set local lock_timeout='3s';
do $$
declare
 host uuid:=gen_random_uuid();member uuid:=gen_random_uuid();guest uuid:=gen_random_uuid();outsider uuid:=gen_random_uuid();
 home uuid;trip uuid;party uuid;expense uuid;refund uuid;payment uuid;request uuid:=gen_random_uuid();
 token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 member_token text;hash text;added jsonb;preview jsonb;snap jsonb;before_finances jsonb;after_finances jsonb;delivery jsonb;status jsonb;
 denied boolean;
begin
 if has_table_privilege('authenticated','public.group_participants','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('anon','public.group_participants','SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('authenticated','private.participant_contacts','SELECT,INSERT,UPDATE,DELETE')
  or has_function_privilege('anon','public.accept_invitation_v2(text,text)','EXECUTE')
  or has_function_privilege('authenticated','private.participant_auth_user(uuid,uuid)','EXECUTE') then
  raise exception 'QA failure: participant grants are too broad';
 end if;
 insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
 select id,'authenticated','authenticated',id::text||'@example.invalid',now(),
  '{"providers":["google"],"provider":"google"}'::jsonb,jsonb_build_object('full_name',name)
 from (values(host,'QA organiser'),(member,'QA member'),(outsider,'QA unrelated person')) fixture(id,name);
 perform set_config('request.jwt.claim.sub',host::text,true);execute 'set local role authenticated';
 home:=public.create_space('QA pending home','household',null,array[]::uuid[],gen_random_uuid());
 member_token:=public.create_invitation(home,member::text||'@example.invalid');
 perform set_config('request.jwt.claim.sub',member::text,true);perform public.accept_invitation(member_token);
 perform set_config('request.jwt.claim.sub',host::text,true);
 trip:=public.create_space('QA pending event','trip',home,array[member],gen_random_uuid());
 added:=public.add_pending_participant(trip,'QA invited friend',guest::text||'@example.invalid',request,token);
 if added<>public.add_pending_participant(trip,'QA invited friend',guest::text||'@example.invalid',request,token) then raise exception 'QA failure: add replay changed';end if;
 party:=(added->>'participant_id')::uuid;
 if party=guest then raise exception 'QA failure: fabricated account identity';end if;
 denied:=false;begin perform public.get_household_state(trip,50);exception when raise_exception then
  if sqlerrm like 'client_update_required:%' then denied:=true;else raise;end if;end;
 if not denied then raise exception 'QA failure: legacy snapshot silently omits pending balances';end if;
 perform set_config('request.jwt.claim.sub',member::text,true);
 denied:=false;begin perform public.add_pending_participant(trip,'QA denied','denied@example.invalid',gen_random_uuid(),token);exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'QA failure: ordinary member can prepare an invitation';end if;
 perform set_config('request.jwt.claim.sub',host::text,true);
 expense:=public.create_expense(trip,gen_random_uuid(),'QA exact expense',1001,party,array[host,party],'exact',jsonb_build_object(host::text,400,party::text,601),current_date,'other','');
 refund:=public.refund_expense(trip,expense,101,'QA partial refund',gen_random_uuid());
 snap:=public.get_group_state_v4(trip,50);
 before_finances:=jsonb_build_array(snap->'expenses',snap->'shares',snap->'refunds',snap->'refund_shares',snap->'balances');
 if not exists(select 1 from jsonb_array_elements(snap->'members') m where m->>'id'=party::text and m->>'status'='invited' and (m->>'can_select')::boolean and not (m->>'can_repay')::boolean) then
  raise exception 'QA failure: pending participant capabilities';
 end if;
 denied:=false;begin perform public.record_payment(trip,party,10,current_date,'QA denied',gen_random_uuid());exception when raise_exception then
  if sqlerrm like 'invalid_payment%' then denied:=true;else raise;end if;end;
 if not denied then raise exception 'QA failure: unjoined participant can receive repayment';end if;
 execute 'reset role';
 if exists(select 1 from auth.users where id=guest) or exists(select 1 from public.profiles where id=party)
  or exists(select 1 from public.group_members where group_id=trip and user_id=party) then raise exception 'QA failure: placeholder Auth/profile/access row';end if;
 hash:=encode(sha256(convert_to(token,'UTF8')),'hex');
 if (select token_hash from public.invitations where id=(added->>'invitation_id')::uuid)<>hash then raise exception 'QA failure: invitation token is not hash-only';end if;
 if to_regprocedure('public.begin_invitation_email(uuid,uuid,text,text,text,text)') is not null then
  if has_table_privilege('authenticated','private.invitation_email_deliveries','SELECT,INSERT,UPDATE,DELETE')
   or has_function_privilege('authenticated','public.begin_invitation_email(uuid,uuid,text,text,text,text)','EXECUTE') then raise exception 'QA failure: email service privileges';end if;
  execute 'set local role service_role';
  delivery:=public.begin_invitation_email(host,trip,hash,'Pact QA <qa@example.invalid>','https://qa.example.invalid','invitation-v1');
  if not (delivery->>'claimed')::boolean then raise exception 'QA failure: email lease not claimed';end if;
  status:=public.begin_invitation_email(host,trip,hash,'Pact QA <qa@example.invalid>','https://qa.example.invalid','invitation-v1');
  if (status->>'claimed')::boolean or status->>'id'<>delivery->>'id' then raise exception 'QA failure: duplicate email lease';end if;
  -- Simulated provider rejection. No actual email request is made.
  perform public.finish_invitation_email((delivery->>'id')::uuid,(delivery->>'lease_id')::uuid,'failed',null,'provider_rejected');
  execute 'set local role authenticated';
  status:=public.get_invitation_email_status(trip,hash);
  if status->0->>'status'<>'failed' or (status->0) ?| array['lease_id','recipient','provider_id','token','token_hash'] then raise exception 'QA failure: organizer email status';end if;
  execute 'reset role';
 end if;
 -- The real account is created only when the fictional person signs up.
 insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
 values(guest,'authenticated','authenticated',guest::text||'@example.invalid',now(),
  '{"providers":["google"],"provider":"google"}','{"full_name":"QA joined friend"}');
 execute 'set local role authenticated';perform set_config('request.jwt.claim.sub',outsider::text,true);
 denied:=false;begin perform public.get_invitation_preview(token);exception when raise_exception then
  if sqlerrm='invalid_invitation' then denied:=true;else raise;end if;end;
 if not denied then raise exception 'QA failure: wrong account sees preview';end if;
 perform set_config('request.jwt.claim.sub',guest::text,true);
 preview:=public.get_invitation_preview(token);
 if preview->>'participant_id'<>party::text or (preview->>'paid_cents')::bigint<>900
  or (preview->>'expense_count')::integer<>1 or preview ?| array['members','expenses','intended_email'] then raise exception 'QA failure: private join summary';end if;
 denied:=false;begin perform public.accept_invitation(token);exception when raise_exception then
  if sqlerrm like 'invitation_review_required:%' then denied:=true;else raise;end if;end;
 if not denied then raise exception 'QA failure: old accept skips prior records';end if;
 if public.accept_invitation_v2(token,preview->>'review_digest')<>trip or public.accept_invitation_v2(token,preview->>'review_digest')<>trip then raise exception 'QA failure: claim replay';end if;
 snap:=public.get_group_state_v4(trip,50);
 after_finances:=jsonb_build_array(snap->'expenses',snap->'shares',snap->'refunds',snap->'refund_shares',snap->'balances');
 if before_finances<>after_finances or snap->>'my_participant_id'<>party::text then raise exception 'QA failure: claim moved or recalculated ledger';end if;
 denied:=false;begin perform public.get_group_state_v4(home,50);exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'QA failure: trip claim enrolled household';end if;
 if to_regprocedure('public.set_payment_preferences(boolean)') is not null then perform public.set_payment_preferences(true);end if;
 perform set_config('request.jwt.claim.sub',host::text,true);
 payment:=public.record_payment(trip,party,100,current_date,'QA real-account payment',gen_random_uuid());
 perform set_config('request.jwt.claim.sub',guest::text,true);
 perform public.payment_action(trip,payment,'confirm',1,'',gen_random_uuid());
 if to_regprocedure('public.record_repayment(uuid,uuid,text,bigint,date,text,boolean,uuid)') is not null then
  perform public.record_repayment(trip,host,'received',25,current_date,'QA receipt',true,gen_random_uuid());
 end if;
 snap:=public.get_group_state_v4(trip,50);
 if (select sum((b->>'cents')::bigint) from jsonb_array_elements(snap->'balances') b)<>0 then raise exception 'QA failure: ledger no longer sums to zero';end if;
 perform set_config('request.jwt.claim.sub',host::text,true);
 perform public.group_action(trip,'remove_member',guest,'',gen_random_uuid());
 perform set_config('request.jwt.claim.sub',guest::text,true);
 denied:=false;begin perform public.get_group_state_v4(trip,50);exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'QA failure: removed account retains access';end if;
 execute 'reset role';
 if not exists(select 1 from public.expenses where id=expense and cash_actor_id=party and created_by=host)
  or not exists(select 1 from public.refund_shares where refund_id=refund and user_id=party)
  or not exists(select 1 from public.group_participants where group_id=trip and id=party and auth_user_id=guest) then raise exception 'QA failure: stable history or actor attribution lost';end if;
end $$;
set constraints all immediate;
rollback;
select 'passed' as pending_participant_database_smoke,
 'All fixtures rolled back. No mail provider, OAuth or device delivery exercised.' as scope;

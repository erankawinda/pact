-- STAGING ONLY. Run as the staging database administrator after all migrations.
-- Execute the entire file in one session. Never replace ROLLBACK with COMMIT.
-- These synthetic role/JWT fixtures test the database, not OAuth signatures or
-- simultaneous connections. The two recording orders are exercised sequentially.

-- This session-local registry survives the fixture rollback solely to verify
-- cleanup by random IDs. It contains no real users and is dropped at the end.
begin;
create temporary table pact_repayment_fixture_ids(ids uuid[]) on commit preserve rows;
insert into pact_repayment_fixture_ids values
 (array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]);
commit; -- Only the temporary ID registry; no Auth or application rows exist yet.

begin;
set local statement_timeout='30s';
set local lock_timeout='3s';
create temporary table pact_repayment_validation_result(report jsonb) on commit drop;

create function pg_temp.assert_true(ok boolean,label text) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if ok is distinct from true then raise exception 'VALIDATION FAILED: %',label;end if;
end $$;

create function pg_temp.expect_error(statement text,wanted_state text,wanted_prefix text) returns void
language plpgsql security invoker set search_path='' as $$
declare caught boolean:=false;got_state text;got_message text;
begin
 begin
  execute statement;
 exception when others then
  get stacked diagnostics got_state=returned_sqlstate,got_message=message_text;
  if got_state<>wanted_state or got_message not like wanted_prefix||'%' then
   raise exception 'VALIDATION FAILED: expected % / %, got % / %',wanted_state,wanted_prefix,got_state,got_message;
  end if;
  caught:=true;
 end;
 if not caught then raise exception 'VALIDATION FAILED: expected rejection: %',statement;end if;
end $$;

create function pg_temp.actor(id uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform set_config('request.jwt.claim.sub',coalesce(id::text,''),true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',id,'role','authenticated')::text,true);
end $$;
grant execute on function pg_temp.assert_true(boolean,text),pg_temp.expect_error(text,text,text),pg_temp.actor(uuid) to authenticated,anon;

do $$
declare
 ids uuid[];a uuid;b uuid;outsider uuid;unverified uuid;email_user uuid;gid uuid;trip uuid;token text;
 received uuid;separate_received uuid;organiser_payment uuid;pending uuid;legacy_request uuid:=gen_random_uuid();
 received_request uuid:=gen_random_uuid();reverse_request uuid:=gen_random_uuid();confirm_request uuid:=gen_random_uuid();
 separate_request uuid:=gen_random_uuid();trip_request uuid:=gen_random_uuid();
 automatic uuid;automatic_legacy uuid;preference_pending uuid;policy_request uuid:=gen_random_uuid();
 snap jsonb;expected jsonb;checks text[]:=array[]::text[];person uuid;amount bigint;fn text;pay_count bigint;
begin
 select f.ids into ids from pg_temp.pact_repayment_fixture_ids f;
 a:=ids[1];b:=ids[2];outsider:=ids[3];unverified:=ids[4];email_user:=ids[5];
 perform pg_temp.assert_true(not exists(select 1 from auth.users where id=any(ids)),'random fixture IDs unused');
 perform pg_temp.assert_true(to_regprocedure('public.record_repayment(uuid,uuid,text,bigint,date,text,boolean,uuid)') is not null,'received repayment migration present');
 perform pg_temp.assert_true((select count(*)=2 and bool_and(
  p.prosecdef=(n.nspname='private') and p.proconfig=array['search_path=""']::text[] and p.prorettype='uuid'::regtype
  and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname='record_repayment'),
  'new RPC has invoker wrapper, narrow grants and fixed search paths');
 foreach fn in array array['private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean)','private.lock_payment_pair(uuid,uuid,uuid)'] loop
  perform pg_temp.assert_true(not has_function_privilege('authenticated',fn,'execute') and not has_function_privilege('anon',fn,'execute'),'internal helper inaccessible');
  perform pg_temp.assert_true((select proconfig=array['search_path=""']::text[] from pg_proc where oid=fn::regprocedure),'internal helper fixed search path');
 end loop;
 perform pg_temp.assert_true((select relrowsecurity from pg_class where oid='public.payments'::regclass),'payments RLS enabled');
 perform pg_temp.assert_true(not has_table_privilege('authenticated','public.payments','UPDATE,INSERT,DELETE'),'direct payment mutations denied');
 perform pg_temp.assert_true((select attnotnull from pg_attribute where attrelid='public.payments'::regclass and attname='recorded_by'),'recorder metadata required');
 checks:=array_append(checks,'Function grants, invoker/definer boundary, fixed search paths, RLS and recorder metadata');

 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data) values
  (a,a::text||'@example.test',now(),'{"full_name":"Synthetic receiver"}','{"provider":"google","providers":["google"]}'),
  (b,b::text||'@example.test',now(),'{"full_name":"Synthetic sender"}','{"provider":"google","providers":["google"]}'),
  (outsider,outsider::text||'@example.test',now(),'{"full_name":"Synthetic outsider"}','{"provider":"google","providers":["google"]}'),
  (unverified,unverified::text||'@example.test',null,'{}','{"provider":"google","providers":["google"]}'),
  (email_user,email_user::text||'@example.test',now(),'{"providers":["google"]}','{"provider":"email","providers":["email"]}');
 perform pg_temp.actor(a);perform set_config('role','authenticated',true);
 perform pg_temp.assert_true(current_user='authenticated' and auth.uid()=a,'actual authenticated role and synthetic subject');
 gid:=public.create_group('Synthetic repayment validation');token:=public.create_invitation(gid,b::text||'@example.test');
 perform pg_temp.actor(b);perform pg_temp.assert_true(public.accept_invitation(token)=gid,'synthetic second member joined');perform pg_temp.actor(a);
 -- Default automatic settlement is a recipient-owned account preference.
 perform pg_temp.assert_true(public.get_payment_preferences()=false,'existing and new profiles default to automatic settlement');
 perform pg_temp.expect_error('select public.set_payment_preferences(null)','22023','invalid_payment_preferences');
 perform pg_temp.expect_error(format('select public.set_payment_preferences(%L,false)',b),'42883','function');
 perform pg_temp.expect_error('update public.profiles set require_payment_approval=true','42501','permission denied');
 perform pg_temp.actor(b);
 automatic:=public.record_repayment(gid,a,'sent',11,current_date,'Policy fixture',false,policy_request);
 automatic_legacy:=public.record_payment(gid,a,13,current_date,'Policy fixture',gen_random_uuid());
 perform pg_temp.assert_true((select count(*)=2 and bool_and(status='confirmed' and confirmation_method='automatic' and recorded_by=b and confirmed_at is not null)
  from public.payments where id in (automatic,automatic_legacy)),'both sender APIs settle automatically by default');
 perform pg_temp.assert_true((select count(*)=2 and bool_and(action='payment_recorded' and actor_id=b and after_data->>'confirmation_method'='automatic')
  from public.activity_log where entity_id in (automatic,automatic_legacy)),'automatic settlement audit preserves reporting actor and method');
 snap:=public.get_household_state(gid,50);
 perform pg_temp.assert_true((select (v->>'cents')::bigint=-24 from jsonb_array_elements(snap->'balances') v where v->>'user_id'=a::text),'automatic reports immediately update balances');
 perform pg_temp.actor(a);perform public.set_payment_preferences(true);perform public.update_profile('Synthetic receiver renamed');
 perform pg_temp.assert_true(public.get_payment_preferences()=true,'display-name edits preserve payment preference');
 perform pg_temp.actor(b);perform pg_temp.assert_true(public.get_payment_preferences()=false,'recipient preference does not overwrite sender preference');
 perform pg_temp.assert_true(public.record_repayment(gid,a,'sent',11,current_date,'Policy fixture',false,policy_request)=automatic,'committed automatic request replay ignores later policy changes');
 preference_pending:=public.record_repayment(gid,a,'sent',17,current_date,'Policy fixture',false,gen_random_uuid());
 perform pg_temp.actor(a);perform public.set_payment_preferences(false);
 perform pg_temp.assert_true((select status='pending' and confirmation_method is null and confirmed_at is null from public.payments where id=preference_pending),'turning approval off preserves existing pending records');
 perform public.payment_action(gid,preference_pending,'confirm',1,'',gen_random_uuid());
 perform pg_temp.assert_true((select confirmation_method='recipient' from public.payments where id=preference_pending),'pending confirmation records recipient method');
 perform public.payment_action(gid,preference_pending,'reverse',2,'Synthetic cleanup',gen_random_uuid());
 perform public.payment_action(gid,automatic,'reverse',1,'Synthetic cleanup',gen_random_uuid());
 perform public.payment_action(gid,automatic_legacy,'reverse',1,'Synthetic cleanup',gen_random_uuid());
 perform pg_temp.assert_true((select confirmation_method='automatic' from public.payments where id=automatic),'reversal preserves automatic origin');
 perform pg_temp.assert_true((select count(*)=4 and bool_and(p.prosecdef=(n.nspname='private') and p.proconfig=array['search_path=""']::text[]
  and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('get_payment_preferences','set_payment_preferences')),'preference functions have narrow grants and pinned paths');
 checks:=array_append(checks,'Default automatic and legacy settlement, own preference isolation, stable retries, preserved pending history and audit origins');

 perform public.create_expense(gid,gen_random_uuid(),'Synthetic groceries',1001,a,array[a,b],'exact',jsonb_build_object(a::text,501,b::text,500),current_date,'groceries','');
 received:=public.record_repayment(gid,b,'received',500,current_date,' Bank transfer ',false,received_request);
 perform pg_temp.assert_true(public.record_repayment(gid,b,'received',500,current_date,' Bank transfer ',false,received_request)=received,'same received request returns same ID');
 perform pg_temp.assert_true((select status='confirmed' and confirmation_method='recipient' and sender_id=b and recipient_id=a and recorded_by=a and confirmed_at is not null and note='Bank transfer' and version=1
  from public.payments where id=received),'received row has correct identity, status and metadata');
 snap:=public.get_household_state(gid,50);
 perform pg_temp.assert_true((select bool_and((v->>'cents')::bigint=0) from jsonb_array_elements(snap->'balances') v),'receipt immediately settles exact balances');
 expected:=jsonb_build_object('sender_id',b,'recipient_id',a,'amount_cents',500,'occurred_on',current_date,'separate_payment',false,'confirmation_method','recipient');
 perform pg_temp.assert_true((select count(*)=1 and bool_and(actor_id=a and action='payment_received' and after_data=expected) from public.activity_log where entity_id=received),'one complete recipient audit entry');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',500,current_date,'' Bank transfer '',true,%L)',gid,b,received_request),'P0001','idempotency_conflict');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''sent'',500,current_date,'' Bank transfer '',false,%L)',gid,b,received_request),'P0001','idempotency_conflict');
 checks:=array_append(checks,'Recipient acknowledgement settles cents immediately with actor audit and safe immutable replay');

 perform pg_temp.actor(b);
 perform pg_temp.expect_error(format('select public.payment_action(%L,%L,''reverse'',1,''Not recipient'',%L)',gid,received,gen_random_uuid()),'P0001','invalid_action');
 perform pg_temp.actor(a);
 perform pg_temp.expect_error(format('select public.payment_action(%L,%L,''reverse'',1,'''',%L)',gid,received,gen_random_uuid()),'P0001','reason_required');
 perform public.payment_action(gid,received,'reverse',1,'Synthetic correction',reverse_request);
 perform pg_temp.assert_true(public.payment_action(gid,received,'reverse',1,'Synthetic correction',reverse_request)=received,'reversal retry returns same row');
 perform pg_temp.expect_error(format('select public.payment_action(%L,%L,''reverse'',1,''Again'',%L)',gid,received,gen_random_uuid()),'P0001','stale_version');
 snap:=public.get_household_state(gid,50);
 perform pg_temp.assert_true((select (v->>'cents')::bigint=500 from jsonb_array_elements(snap->'balances') v where v->>'user_id'=a::text),'reversal restores receiver balance');
 perform pg_temp.assert_true((select status='reversed' from public.payments where id=received),'reversal retains original record');
 perform pg_temp.actor(b);organiser_payment:=public.record_repayment(gid,a,'received',42,current_date,'',false,gen_random_uuid());
 perform pg_temp.actor(a);perform public.payment_action(gid,organiser_payment,'reverse',1,'Organiser correction',gen_random_uuid());
 perform pg_temp.assert_true((select status='reversed' from public.payments where id=organiser_payment),'organiser may reverse a record received by someone else');
 checks:=array_append(checks,'Only recipient or organiser can reverse; reason, version and replay preserve history');

 -- Sender-first ordering and old API compatibility, including the original hash.
 perform public.set_payment_preferences(true);
 perform pg_temp.actor(b);pending:=public.record_payment(gid,a,500,current_date,'',legacy_request);
 perform pg_temp.assert_true(public.record_payment(gid,a,500,current_date,'',legacy_request)=pending,'legacy request replay');
 perform pg_temp.assert_true((select status='pending' and recorded_by=b and confirmed_at is null and confirmation_method is null from public.payments where id=pending),'legacy sender report stays pending');
 perform pg_temp.expect_error(format('select public.payment_action(%L,%L,''confirm'',1,'''',%L)',gid,pending,gen_random_uuid()),'P0001','invalid_action');
 perform pg_temp.expect_error(format('select public.record_payment(%L,%L,500,current_date,'''',%L)',gid,a,gen_random_uuid()),'P0001','payment_already_recorded');
 execute 'reset role';
 perform pg_temp.assert_true((select payload_hash=encode(sha256(convert_to(jsonb_build_array('payment',gid,a,500,current_date,'')::text,'UTF8')),'hex')
  from public.operation_requests where actor_id=b and request_id=legacy_request),'legacy payload hash remains unchanged');
 perform set_config('role','authenticated',true);perform pg_temp.actor(a);
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',500,current_date,'''',false,%L)',gid,b,gen_random_uuid()),'P0001','payment_pending_exists');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date-1,'''',true,%L)',gid,b,gen_random_uuid()),'P0001','payment_pending_exists');
 snap:=public.get_household_state(gid,50);
 perform pg_temp.assert_true((select (v->>'cents')::bigint=500 from jsonb_array_elements(snap->'balances') v where v->>'user_id'=a::text),'pending has no balance effect');
 perform public.payment_action(gid,pending,'confirm',1,'',confirm_request);
 perform pg_temp.assert_true(public.payment_action(gid,pending,'confirm',1,'',confirm_request)=pending,'confirmation retry safe');
 checks:=array_append(checks,'Legacy sender-first path, preserved hash, pending resolution and recipient-only confirmation');

 -- Receiver-first ordering blocks a later matching sender report.
 separate_received:=public.record_repayment(gid,b,'received',250,current_date,'',false,gen_random_uuid());
 perform pg_temp.actor(b);
 perform pg_temp.expect_error(format('select public.record_payment(%L,%L,250,current_date,'''',%L)',gid,a,gen_random_uuid()),'P0001','payment_already_recorded');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''sent'',250,current_date,'''',false,%L)',gid,a,gen_random_uuid()),'P0001','payment_already_recorded');
 perform pg_temp.actor(a);
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',250,current_date,'''',false,%L)',gid,b,gen_random_uuid()),'P0001','payment_already_recorded');
 received:=public.record_repayment(gid,b,'received',250,current_date,'',true,separate_request);
 perform pg_temp.assert_true(received<>separate_received,'separate acknowledged transfer receives own row');
 perform pg_temp.assert_true(public.record_repayment(gid,b,'received',250,current_date,'',true,separate_request)=received,'separate transfer replay safe');
 snap:=public.get_household_state(gid,50);
 perform pg_temp.assert_true((select (v->>'cents')::bigint=-500 from jsonb_array_elements(snap->'balances') v where v->>'user_id'=a::text),'two actual transfers counted exactly once each');
 checks:=array_append(checks,'Receiver-first duplicates blocked; deliberate separate transfer allowed without replay duplication');

 select count(*) into pay_count from public.payments where group_id=gid;
 foreach amount in array array[0::bigint,-1,100000001,null] loop
  perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',%L,current_date,'''',false,%L)',gid,b,amount,gen_random_uuid()),'P0001','invalid_amount');
 end loop;
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''invalid'',1,current_date,'''',false,%L)',gid,b,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,''infinity'','''',false,%L)',gid,b,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date,%L,false,%L)',gid,b,repeat('x',501),gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.assert_true((select count(*)=pay_count from public.payments where group_id=gid),'invalid writes rolled back');
 perform public.record_repayment(gid,b,'received',1,current_date,'',false,gen_random_uuid());
 perform public.record_repayment(gid,b,'received',100000000,current_date,'',false,gen_random_uuid());
 snap:=public.get_household_state(gid,50);
 perform pg_temp.assert_true((select sum((v->>'cents')::bigint)=0 from jsonb_array_elements(snap->'balances') v),'min and max amounts keep ledger zero-sum');
 checks:=array_append(checks,'Invalid amount, direction, date and note rejected; cent boundaries conserve balances');

 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date,'''',false,%L)',gid,a,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date,'''',false,%L)',gid,outsider,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.expect_error('delete from public.payments','42501','permission denied');
 perform pg_temp.expect_error(format('select private.insert_repayment(%L,%L,''received'',1,current_date,'''',false)',gid,b),'42501','permission denied');
 perform pg_temp.expect_error(format('select private.lock_payment_pair(%L,%L,%L)',gid,b,a),'42501','permission denied');
 perform pg_temp.actor(outsider);
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date,'''',false,%L)',gid,b,gen_random_uuid()),'42501','forbidden');
 foreach person in array array[unverified,email_user,null::uuid] loop
  perform pg_temp.actor(person);
  perform pg_temp.expect_error('select public.get_payment_preferences()','28000','unauthenticated');
  perform pg_temp.expect_error('select public.set_payment_preferences(true)','28000','unauthenticated');
  perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date,'''',false,%L)',gid,b,gen_random_uuid()),'28000','unauthenticated');
 end loop;
 execute 'reset role';perform set_config('role','anon',true);
 perform pg_temp.expect_error('select public.get_payment_preferences()','42501','permission denied');
 perform pg_temp.expect_error('select public.set_payment_preferences(true)','42501','permission denied');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',1,current_date,'''',false,%L)',gid,b,gen_random_uuid()),'42501','permission denied');
 execute 'reset role';perform set_config('role','authenticated',true);perform pg_temp.actor(a);
 checks:=array_append(checks,'Self, outsider, unauthenticated, unverified and email-only writes denied; helpers and tables protected');

 trip:=public.create_space('Synthetic private trip','trip',gid,array[a,b],gen_random_uuid());
 snap:=public.get_household_state(trip,50);
 perform pg_temp.assert_true((select (m->>'require_payment_approval')::boolean from jsonb_array_elements(snap->'members') m where m->>'id'=a::text),'own preference is shared by household and trip snapshots');
 perform pg_temp.actor(b);preference_pending:=public.record_repayment(trip,a,'sent',7,current_date,'Policy fixture',false,gen_random_uuid());
 perform pg_temp.assert_true((select status='pending' from public.payments where id=preference_pending),'trip follows same opt-in approval policy');
 perform public.payment_action(trip,preference_pending,'cancel',1,'',gen_random_uuid());
 perform pg_temp.actor(a);perform public.set_payment_preferences(false);
 perform pg_temp.actor(b);automatic:=public.record_repayment(trip,a,'sent',8,current_date,'Policy fixture',false,gen_random_uuid());
 perform pg_temp.assert_true((select status='confirmed' and confirmation_method='automatic' from public.payments where id=automatic),'trip follows later automatic preference');
 perform pg_temp.actor(a);perform public.payment_action(trip,automatic,'reverse',1,'Synthetic cleanup',gen_random_uuid());
 checks:=array_append(checks,'Recipient-owned approval policy is global across household and trip');
 received:=public.record_repayment(trip,b,'received',1,current_date,'',false,trip_request);
 perform public.group_action(gid,'remove_member',b,'',gen_random_uuid());
 execute 'reset role';update public.group_members set status='active' where group_id=trip and user_id=b;
 perform set_config('role','authenticated',true);
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',2,current_date,'''',false,%L)',trip,b,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''sent'',2,current_date,'''',false,%L)',trip,b,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.expect_error(format('select public.record_payment(%L,%L,2,current_date,'''',%L)',trip,b,gen_random_uuid()),'P0001','invalid_payment');
 perform pg_temp.actor(b);
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',2,current_date,'''',false,%L)',trip,a,gen_random_uuid()),'42501','forbidden');
 perform pg_temp.assert_true(public.record_payment(gid,a,500,current_date,'',legacy_request)=pending,'revoked sender can reconcile only their own committed receipt');
 perform pg_temp.actor(a);
 perform pg_temp.assert_true((select count(*)=3 from public.payments where group_id=trip),'trip history retained after member revocation');
 checks:=array_append(checks,'Trip counterpart requires active parent membership; revoked actor denied with history and old receipt preserved');

 perform public.group_action(trip,'archive',null,'',gen_random_uuid());
 perform pg_temp.assert_true(public.record_repayment(trip,b,'received',1,current_date,'',false,trip_request)=received,'new request replay remains safe after archive');
 perform pg_temp.expect_error(format('select public.record_repayment(%L,%L,''received'',2,current_date,'''',false,%L)',trip,b,gen_random_uuid()),'42501','forbidden');
 checks:=array_append(checks,'Archived groups reject new writes while committed request reconciliation remains available');
 execute 'reset role';
 insert into pg_temp.pact_repayment_validation_result values(jsonb_build_object(
  'status','PASS','scope','staging database role checks; no OAuth or concurrent-session claim',
  'check_groups',cardinality(checks),'checks',checks,'synthetic_users',cardinality(ids),'synthetic_groups',2,'rollback_required',true));
end $$;

set constraints all immediate;
select report from pg_temp.pact_repayment_validation_result;
rollback;

-- This is a separate cleanup result, not a claim that preceding assertions passed.
select 'POST_ROLLBACK_FIXTURE_COUNTS' as check_name,
 (select count(*) from auth.users where id=any(f.ids)) as auth_users,
 (select count(*) from public.profiles where id=any(f.ids)) as profiles,
 (select count(*) from public.groups where created_by=any(f.ids)) as groups,
 (select count(*) from public.payments where recorded_by=any(f.ids)) as payments,
 (select count(*) from public.operation_requests where actor_id=any(f.ids)) as requests
from pg_temp.pact_repayment_fixture_ids f;
drop table pg_temp.pact_repayment_fixture_ids;

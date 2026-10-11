import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const migration='20261011030705_received_repayments.sql';
const preferencesMigration='20261011035030_recipient_payment_preferences.sql';
type Payment={id:string;sender_id:string;recipient_id:string;amount_cents:number;status:string;version:number;recorded_by:string;confirmed_at:string|null;confirmation_method:'recipient'|'automatic'|null;note:string};
type State={members:{id:string;require_payment_approval:boolean}[];payments:Payment[];balances:{user_id:string;cents:number}[];activity:{actor_id:string;action:string;entity_id:string;after_data:Record<string,unknown>}[]};

async function fixture(t:TestContext,withMigration=true){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 await db.exec(await readFile(new URL('./fixtures/platform.sql',import.meta.url),'utf8'));
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()){
  if(file>=migration&&!withMigration)continue;
  await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 }
 const a=randomUUID(),b=randomUUID(),outsider=randomUUID();
 await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'receiver@example.test',now()),($2,'sender@example.test',now()),($3,'outsider@example.test',now())",[a,b,outsider]);
 async function as(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
 async function scalar<T=string>(sql:string,args:unknown[]=[]){return Object.values((await db.query<Record<string,T>>(sql,args)).rows[0])[0];}
 await as(a);const group=await scalar("select public.create_group('Repayment test')");
 const invitation=await scalar('select public.create_invitation($1,$2)',[group,'sender@example.test']);
 await as(b);await scalar('select public.accept_invitation($1)',[invitation]);await as(a);
 const state=(g=group)=>scalar<State>('select public.get_household_state($1,50)',[g]);
 const balances=async(g=group)=>Object.fromEntries((await state(g)).balances.map(v=>[v.user_id,Number(v.cents)]));
 const record=(other:string,direction:string|null,amount:number|string|null=500,request=randomUUID(),separate:boolean|null=false,date:string|null='2026-10-11',note:string|null='',g=group)=>
  scalar('select public.record_repayment($1,$2,$3,$4,$5,$6,$7,$8)',[g,other,direction,amount,date,note,separate,request]);
 const legacy=(recipient:string,amount=500,request=randomUUID(),g=group)=>scalar("select public.record_payment($1,$2,$3,'2026-10-11','',$4)",[g,recipient,amount,request]);
 const action=(id:string,kind:string,version:number,reason='',request=randomUUID(),g=group)=>scalar('select public.payment_action($1,$2,$3,$4,$5,$6)',[g,id,kind,version,reason,request]);
 const preferences=(required:boolean|null)=>scalar<boolean>('select public.set_payment_preferences($1)',[required]);
 const getPreferences=()=>scalar<boolean>('select public.get_payment_preferences()');
 return {db,a,b,outsider,group,as,scalar,state,balances,record,legacy,action,preferences,getPreferences};
}

test('migration backfills the recorder and preserves legacy payment and action receipts',async t=>{
 const f=await fixture(t,false);const {db,a,b,group,as,legacy,action,state,record}=f;
 await as(b);const request=randomUUID(),pending=await legacy(a,501,request);
 await as(a);const confirmed=await legacy(b,250);await as(b);
 const confirmRequest=randomUUID();await action(confirmed,'confirm',1,'',confirmRequest);
 const reversed=await legacy(a,125);await as(a);await action(reversed,'confirm',1);await action(reversed,'reverse',2,'Before migration');
 await as(b);const cancelled=await legacy(a,126);await action(cancelled,'cancel',1);
 const rejected=await legacy(a,127);await as(a);await action(rejected,'reject',1);
 await db.exec('reset role');await db.exec(await readFile('supabase/migrations/'+migration,'utf8'));
 await db.exec(await readFile('supabase/migrations/'+preferencesMigration,'utf8'));await as(b);
 assert.equal(await legacy(a,501,request),pending,'the old payment payload hash remains valid');
 assert.equal(await action(confirmed,'confirm',1,'',confirmRequest),confirmed,'the old action receipt remains valid');
 const payments=(await state()).payments;
 assert.equal(payments.find(p=>p.id===pending)?.recorded_by,b);
 assert.equal(payments.find(p=>p.id===confirmed)?.recorded_by,a);
 assert.equal(payments.find(p=>p.id===pending)?.confirmation_method,null);
 assert.equal(payments.find(p=>p.id===confirmed)?.confirmation_method,'recipient');
 assert.equal(payments.find(p=>p.id===reversed)?.confirmation_method,'recipient');
 assert.equal(payments.find(p=>p.id===reversed)?.status,'reversed');
 for(const id of [pending,cancelled,rejected])assert.equal(payments.find(p=>p.id===id)?.confirmation_method,null);
 assert.equal(payments.find(p=>p.id===pending)?.status,'pending','migration never settles existing pending records');
 assert.equal(payments.find(p=>p.id===cancelled)?.status,'cancelled');
 assert.equal(payments.find(p=>p.id===rejected)?.status,'rejected');
 assert.equal(await f.getPreferences(),false);
 await assert.rejects(()=>legacy(a,502,request),/idempotency_conflict/);
 // New and legacy actors can reconcile their own committed requests even after archive.
 await as(a);await action(pending,'reject',1);
 const receivedRequest=randomUUID();const received=await record(b,'received',1,receivedRequest,false,'2026-10-12');
 await f.scalar("select public.group_action($1,'archive',null,'',$2)",[group,randomUUID()]);
 assert.equal(await record(b,'received',1,receivedRequest,false,'2026-10-12'),received);
 await as(b);assert.equal(await legacy(a,501,request),pending);
 await assert.rejects(()=>legacy(a,1),/forbidden/);
});

test('recipient acknowledgement updates exact balances immediately and remains auditable and reversible',async t=>{
 const {a,b,group,as,scalar,state,balances,record,action}=await fixture(t);
 await scalar("select public.create_expense($1,$2,'Shared groceries',1001,$3,$4::uuid[],'exact',$5::jsonb,'2026-10-11','groceries','')",
  [group,randomUUID(),a,[a,b],JSON.stringify({[a]:501,[b]:500})]);
 assert.deepEqual(await balances(),{[a]:500,[b]:-500});
 const request=randomUUID(),received=await record(b,'received',500,request,false,'2026-10-11',' Bank transfer ');
 assert.deepEqual(await balances(),{[a]:0,[b]:0});
 const payment=(await state()).payments.find(p=>p.id===received)!;
 assert.equal(payment.sender_id,b);assert.equal(payment.recipient_id,a);assert.equal(payment.recorded_by,a);
 assert.equal(payment.status,'confirmed');assert.equal(payment.confirmation_method,'recipient');assert.equal(payment.version,1);assert.ok(payment.confirmed_at);assert.equal(payment.note,'Bank transfer');
 assert.equal(await record(b,'received',500,request,false,'2026-10-11',' Bank transfer '),received);
 await assert.rejects(()=>record(b,'received',500,request,true,'2026-10-11',' Bank transfer '),/idempotency_conflict/);
 await assert.rejects(()=>record(b,'sent',500,request,false,'2026-10-11',' Bank transfer '),/idempotency_conflict/);
 const activity=(await state()).activity.filter(v=>v.entity_id===received);
 assert.equal(activity.length,1);assert.equal(activity[0].action,'payment_received');assert.equal(activity[0].actor_id,a);
 assert.deepEqual(activity[0].after_data,{sender_id:b,recipient_id:a,amount_cents:500,occurred_on:'2026-10-11',separate_payment:false,confirmation_method:'recipient'});
 await as(b);await assert.rejects(()=>action(received,'reverse',1,'Not the recipient'),/invalid_action/);
 await as(a);await assert.rejects(()=>action(received,'reverse',1),/reason_required/);
 const reverseRequest=randomUUID();await action(received,'reverse',1,'Wrong transfer',reverseRequest);
 assert.deepEqual(await balances(),{[a]:500,[b]:-500});
 assert.equal(await action(received,'reverse',1,'Wrong transfer',reverseRequest),received);
 await assert.rejects(()=>action(received,'reverse',1,'Again'),/stale_version/);
 assert.equal((await state()).payments.find(p=>p.id===received)?.status,'reversed');
 // A reversed record may be replaced; legitimate overpayments are not capped to suggestions.
 await record(b,'received',501);assert.deepEqual(await balances(),{[a]:-1,[b]:1});
});

test('both recording orderings prevent accidental duplicates and require explicit pending reconciliation',async t=>{
 const {a,b,as,state,balances,record,legacy,action,preferences}=await fixture(t);
 await preferences(true);
 // Sender first: the recipient sees and confirms the actual existing record.
 await as(b);const pending=await legacy(a);
 await assert.rejects(()=>legacy(a),/payment_already_recorded/);
 await assert.rejects(()=>record(a,'sent'),/payment_already_recorded/);
 await assert.rejects(()=>action(pending,'confirm',1),/invalid_action/);
 await as(a);
 await assert.rejects(()=>record(b,'received'),/payment_pending_exists/);
 await assert.rejects(()=>record(b,'received',101,randomUUID(),true,'2026-10-10'),/payment_pending_exists/);
 assert.deepEqual(await balances(),{[a]:0,[b]:0});
 await action(pending,'confirm',1);
 await assert.rejects(()=>record(b,'received'),/payment_already_recorded/);
 assert.equal((await state()).payments.length,1);
 // Receiver first: a later sender report cannot create another matching pending row.
 const received=await record(b,'received',250);
 await as(b);await assert.rejects(()=>legacy(a,250),/payment_already_recorded/);
 await assert.rejects(()=>record(a,'sent',250),/payment_already_recorded/);
 await as(a);await assert.rejects(()=>record(b,'received',250),/payment_already_recorded/);
 // Equal real transfers are allowed only after an explicit separate-payment acknowledgement.
 const separateRequest=randomUUID();const second=await record(b,'received',250,separateRequest,true);
 assert.notEqual(second,received);assert.equal(await record(b,'received',250,separateRequest,true),second);
 assert.equal((await state()).payments.length,3);
 assert.deepEqual(await balances(),{[a]:-1000,[b]:1000});
 await as(b);const third=await record(a,'sent',250,randomUUID(),true);
 assert.deepEqual(await balances(),{[a]:-1000,[b]:1000},'separate sender reports remain pending');
 await as(a);await assert.rejects(()=>record(b,'received',250,randomUUID(),true),/payment_pending_exists/);
 await action(third,'reject',1,'Reported twice');
 assert.equal((await state()).payments.length,4,'rejected history is retained');
 // Cancellation has the same reconciliation effect without changing balances.
 await as(b);const cancelled=await record(a,'sent',1);await action(cancelled,'cancel',1);
 await as(a);await record(b,'received',1);
 const bal=await balances();assert.equal(Object.values(bal).reduce((sum,v)=>sum+v,0),0);
});

test('repayment RPCs enforce participant access, role grants and effective trip membership',async t=>{
 const {db,a,b,outsider,group,as,scalar,state,record,legacy}=await fixture(t);
 await as(outsider);await assert.rejects(()=>record(b,'received'),/forbidden/);
 await as(a);await assert.rejects(()=>record(outsider,'received'),/invalid_payment/);
 await assert.rejects(()=>record(a,'received'),/invalid_payment/);
 await assert.rejects(()=>record(a,'sent'),/invalid_payment/);
 for(const table of ['payments','activity_log','operation_requests'])await assert.rejects(()=>db.query(`delete from public.${table}`),/permission denied/);
 await assert.rejects(()=>scalar('select private.insert_repayment($1,$2,\'received\',1,current_date,\'\',false)',[group,b]),/permission denied/);
 await assert.rejects(()=>scalar('select private.lock_payment_pair($1,$2,$3)',[group,b,a]),/permission denied/);
 const trip=await scalar("select public.create_space('Private trip','trip',$1,$2::uuid[],$3)",[group,[a,b],randomUUID()]);
 await record(b,'received',1,randomUUID(),false,'2026-10-11','',trip);
 await scalar("select public.group_action($1,'remove_member',$2,'',$3)",[group,b,randomUUID()]);
 // Test an orphaned active trip row: the household gate must still apply to counterpart selection.
 await db.exec('reset role');await db.query("update public.group_members set status='active' where group_id=$1 and user_id=$2",[trip,b]);await as(a);
 await assert.rejects(()=>record(b,'received',2,randomUUID(),false,'2026-10-11','',trip),/invalid_payment/);
 await assert.rejects(()=>record(b,'sent',2,randomUUID(),false,'2026-10-11','',trip),/invalid_payment/);
 await assert.rejects(()=>legacy(b,2,randomUUID(),trip),/invalid_payment/);
 await assert.rejects(()=>record(b,'received'),/invalid_payment/);
 await as(b);await assert.rejects(()=>record(a,'received',2,randomUUID(),false,'2026-10-11','',trip),/forbidden/);
 await assert.rejects(()=>record(a,'sent'),/forbidden/);
 await as(a);assert.equal((await state(trip)).payments.length,1,'membership changes retain history');
 await scalar("select public.group_action($1,'archive',null,'',$2)",[trip,randomUUID()]);
 await assert.rejects(()=>record(b,'received',2,randomUUID(),false,'2026-10-11','',trip),/forbidden/);
 await db.exec('reset role;set role anon');
 await assert.rejects(()=>record(b,'received'),/permission denied/);
 await assert.rejects(()=>scalar('select private.record_repayment($1,$2,\'received\',1,current_date,\'\',false,$3)',[group,b,randomUUID()]),/permission denied/);
 await as('');await assert.rejects(()=>record(b,'received'),/unauthenticated/);
});

test('repayment validation preserves exact cents and rolls back rejected writes',async t=>{
 const {db,a,b,as,state,balances,record}=await fixture(t);
 for(const amount of [0,-1,100000001,null])await assert.rejects(()=>record(b,'received',amount),/invalid_amount/);
 await assert.rejects(()=>record(b,'received','1.5'),/invalid input syntax for type bigint/);
 for(const direction of [null,'other'])await assert.rejects(()=>record(b,direction),/invalid_payment/);
 await assert.rejects(()=>record(b,'received',1,randomUUID(),null),/invalid_payment/);
 for(const date of [null,'infinity','-infinity'])await assert.rejects(()=>record(b,'received',1,randomUUID(),false,date),/invalid_payment/);
 await assert.rejects(()=>record(b,'received',1,randomUUID(),false,'2026-10-11','a'.repeat(501)),/invalid_payment/);
 assert.equal((await state()).payments.length,0);
 await record(b,'received',1);await record(b,'received',100000000,randomUUID(),false,'2026-10-12',null);
 assert.deepEqual(await balances(),{[a]:-100000001,[b]:100000001});
 // Verified Google identity remains mandatory, not just possession of an authenticated role.
 await db.exec('reset role');await db.query("update auth.users set raw_app_meta_data='{\"providers\":[\"email\"]}' where id=$1",[a]);await as(a);
 await assert.rejects(()=>record(b,'received',2),/unauthenticated/);
});

test('sender reports settle automatically by default, including legacy clients, with stable replay and origin',async t=>{
 const {a,b,as,state,balances,record,legacy,action,preferences,getPreferences}=await fixture(t);
 assert.equal(await getPreferences(),false);
 assert.equal((await state()).members.find(m=>m.id===a)?.require_payment_approval,false);
 await as(b);assert.equal(await getPreferences(),false);
 const request=randomUUID(),sent=await record(a,'sent',500,request);
 const legacyRequest=randomUUID(),oldClient=await legacy(a,250,legacyRequest);
 assert.deepEqual(await balances(),{[a]:-750,[b]:750});
 let snapshot=await state();
 for(const id of [sent,oldClient]){
  const payment=snapshot.payments.find(p=>p.id===id)!;
  assert.equal(payment.status,'confirmed');assert.equal(payment.confirmation_method,'automatic');
  assert.equal(payment.recorded_by,b);assert.ok(payment.confirmed_at);
  const activity=snapshot.activity.filter(entry=>entry.entity_id===id);
  assert.equal(activity.length,1);assert.equal(activity[0].actor_id,b);
  assert.equal(activity[0].action,'payment_recorded');assert.equal(activity[0].after_data.confirmation_method,'automatic');
 }
 await assert.rejects(()=>record(a,'sent',500),/payment_already_recorded/);
 await assert.rejects(()=>legacy(a,250),/payment_already_recorded/);
 await as(a);await preferences(true);
 await as(b);
 assert.equal(await record(a,'sent',500,request),sent,'policy changes do not alter committed request replay');
 assert.equal(await legacy(a,250,legacyRequest),oldClient,'legacy request hash and replay remain unchanged');
 assert.equal((await state()).payments.length,2);
 await assert.rejects(()=>action(sent,'cancel',1),/invalid_action/);
 await as(a);await assert.rejects(()=>action(sent,'confirm',1),/invalid_action/);
 const reverseRequest=randomUUID();await action(sent,'reverse',1,'Wrong payment',reverseRequest);
 assert.equal(await action(sent,'reverse',1,'Wrong payment',reverseRequest),sent);
 snapshot=await state();assert.equal(snapshot.payments.find(p=>p.id===sent)?.confirmation_method,'automatic');
 assert.deepEqual(await balances(),{[a]:-250,[b]:250});
 assert.equal(snapshot.activity.find(e=>e.entity_id===sent&&e.action==='payment_reversed')?.after_data.confirmation_method,'automatic');
});

test('approval is opt-in per recipient and preference changes never settle existing pending reports',async t=>{
 const {a,b,as,state,balances,record,legacy,action,preferences}=await fixture(t);
 await preferences(true);
 await as(b);const pending=await record(a,'sent',500),oldPending=await legacy(a,250);
 assert.deepEqual(await balances(),{[a]:0,[b]:0});
 let payments=(await state()).payments;
 for(const payment of payments){assert.equal(payment.status,'pending');assert.equal(payment.confirmation_method,null);assert.equal(payment.confirmed_at,null);}
 await as(a);await preferences(false);assert.equal(await preferences(false),false,'retrying the replacement is harmless');
 payments=(await state()).payments;
 assert.ok(payments.every(p=>p.status==='pending'&&p.confirmation_method===null));
 assert.deepEqual(await balances(),{[a]:0,[b]:0},'turning approval off does not retroactively assume money arrived');
 await assert.rejects(()=>record(b,'received',500),/payment_pending_exists/);
 await action(pending,'confirm',1);
 await as(b);await action(oldPending,'cancel',1);
 const auto=await record(a,'sent',10);
 await as(a);await preferences(true);
 const received=await record(b,'received',20);
 payments=(await state()).payments;
 assert.equal(payments.find(p=>p.id===pending)?.confirmation_method,'recipient');
 assert.equal(payments.find(p=>p.id===oldPending)?.confirmation_method,null);
 assert.equal(payments.find(p=>p.id===auto)?.confirmation_method,'automatic');
 assert.equal(payments.find(p=>p.id===received)?.confirmation_method,'recipient');
 assert.deepEqual(await balances(),{[a]:-530,[b]:530});
 assert.equal((await state()).activity.find(e=>e.entity_id===pending&&e.action==='payment_confirmed')?.after_data.confirmation_method,'recipient');
});

test('a recipient preference applies across households and trips and survives display-name edits',async t=>{
 const {a,b,group,as,scalar,state,record,preferences,getPreferences}=await fixture(t);
 const second=await scalar("select public.create_group('Another synthetic home')");
 const invite=await scalar('select public.create_invitation($1,$2)',[second,'sender@example.test']);
 await as(b);await scalar('select public.accept_invitation($1)',[invite]);await as(a);
 const trip=await scalar("select public.create_space('Synthetic trip','trip',$1,$2::uuid[],$3)",[group,[a,b],randomUUID()]);
 await preferences(true);
 await scalar("select public.update_profile('Updated receiver')");
 assert.equal(await getPreferences(),true,'editing a profile name preserves the preference');
 for(const g of [group,second,trip]){
  assert.equal((await state(g)).members.find(m=>m.id===a)?.require_payment_approval,true);
  await as(b);const pending=await record(a,'sent',1,randomUUID(),false,'2026-10-11','',g);
  assert.equal((await state(g)).payments.find(p=>p.id===pending)?.status,'pending');await as(a);
 }
 await preferences(false);
 for(const g of [group,second,trip]){
  assert.equal((await state(g)).members.find(m=>m.id===a)?.require_payment_approval,false);
  await as(b);const settled=await record(a,'sent',2,randomUUID(),false,'2026-10-11','',g);
  assert.equal((await state(g)).payments.find(p=>p.id===settled)?.confirmation_method,'automatic');await as(a);
 }
 // The preference belongs to the recipient, not to the sender or household owner.
 await preferences(true);const toOther=await record(b,'sent',3);
 assert.equal((await state()).payments.find(p=>p.id===toOther)?.confirmation_method,'automatic');
});

test('payment preferences are confined to the verified caller with narrow RPC grants',async t=>{
 const {db,a,b,outsider,as,scalar,preferences,getPreferences}=await fixture(t);
 await preferences(true);
 await as(b);assert.equal(await getPreferences(),false);
 await preferences(false);await as(a);assert.equal(await getPreferences(),true,'one user cannot overwrite another preference');
 await assert.rejects(()=>preferences(null),/invalid_payment_preferences/);
 await assert.rejects(()=>scalar('select public.set_payment_preferences($1,$2)',[b,false]),/does not exist/);
 await assert.rejects(()=>scalar('select public.get_payment_preferences($1)',[b]),/does not exist/);
 await assert.rejects(()=>db.query('update public.profiles set require_payment_approval=false where id=$1',[b]),/permission denied/);
 await as(outsider);assert.equal(await preferences(true),true,'a verified user can configure their own account before joining a household');
 await db.exec('reset role');
 const grants=(await db.query<{name:string;schema:string;definer:boolean;config:string[];anon:boolean;authenticated:boolean;public_execute:boolean}>(`
  select p.proname as name,n.nspname as schema,p.prosecdef as definer,p.proconfig as config,
   has_function_privilege('anon',p.oid,'execute') as anon,
   has_function_privilege('authenticated',p.oid,'execute') as authenticated,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') as public_execute
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.proname in ('get_payment_preferences','set_payment_preferences') order by p.proname,n.nspname`)).rows;
 assert.deepEqual(grants,['get_payment_preferences','set_payment_preferences'].flatMap(name=>[
  {name,schema:'private',definer:true,config:['search_path=""'],anon:false,authenticated:true,public_execute:false},
  {name,schema:'public',definer:false,config:['search_path=""'],anon:false,authenticated:true,public_execute:false}
 ]));
 for(const invalid of ['',randomUUID()]){
  await as(invalid);await assert.rejects(()=>getPreferences(),/unauthenticated/);await assert.rejects(()=>preferences(false),/unauthenticated/);
 }
 await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=null where id=$1',[a]);await as(a);
 await assert.rejects(()=>preferences(false),/unauthenticated/);await assert.rejects(()=>getPreferences(),/unauthenticated/);
 await db.exec('reset role');await db.query("update auth.users set raw_user_meta_data='{\"providers\":[\"google\"]}',raw_app_meta_data='{\"providers\":[\"email\"]}' where id=$1",[b]);await as(b);
 await assert.rejects(()=>preferences(true),/unauthenticated/);await assert.rejects(()=>getPreferences(),/unauthenticated/);
 await db.exec('reset role;set role anon');await assert.rejects(()=>preferences(true),/permission denied/);await assert.rejects(()=>getPreferences(),/permission denied/);
});

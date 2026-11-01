import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {privacyFixture,type PrivacyFixture} from './privacyFixture';

const guestEmail='person4@example.test';
const invite=(f:PrivacyFixture,actor=f.a,email=guestEmail,group=f.trip)=>f.call<string>(actor,'create_invitation',[group,email]);
const action=(f:PrivacyFixture,actor:string,group:string,kind:string,target:string|null)=>f.call<string>(actor,'group_action',[group,kind,target,'',randomUUID()]);
async function joinGuest(f:PrivacyFixture){const token=await invite(f);assert.equal(await f.call(f.outsider,'accept_invitation',[token]),f.trip);return token;}
async function membership(f:PrivacyFixture,user:string,group=f.trip){return (await f.rows('select role,status,access_basis from public.group_members where group_id=$1 and user_id=$2',[group,user]))[0];}

test('an email-bound trip invitation admits a guest to exactly that trip, with no household membership',async t=>{
 const f=await privacyFixture(t);
 const sibling=await f.call<string>(f.a,'create_space',['Another trip','trip',f.home,[],randomUUID()]);
 const token=await invite(f);
 assert.equal((await f.rows('select group_id from public.group_members where user_id=$1',[f.outsider])).length,0,'creating a link does not add its recipient');
 await assert.rejects(()=>f.call(f.outsider,'get_household_state',[f.trip,50]),/forbidden/);
 assert.equal(await f.call(f.outsider,'accept_invitation',[token]),f.trip);
 assert.equal(await f.call(f.outsider,'accept_invitation',[token]),f.trip,'same-account retry is idempotent');
 assert.deepEqual(await membership(f,f.outsider),{role:'member',status:'active',access_basis:'direct'});
 await f.as(f.outsider);
 assert.deepEqual((await f.db.query<{id:string}>('select id from public.groups')).rows.map(g=>g.id),[f.trip]);
 assert.equal((await f.db.query('select * from public.group_members where group_id=$1',[f.home])).rows.length,0);
 for(const group of [f.home,sibling])await assert.rejects(()=>f.call(f.outsider,'get_group_snapshot',[group]),/forbidden/);
 assert.ok((await f.call(f.outsider,'get_household_state',[f.trip,50])).members.some((m:any)=>m.id===f.outsider));
 await f.as(f.outsider);
 for(const sql of ['select private.has_group_access($1,$2)','select private.lock_group_member($1,$2)'])await assert.rejects(()=>f.db.query(sql,[f.a,f.home]),/permission denied/);
 await assert.rejects(()=>f.db.query('select private.lock_group_scope($1)',[f.home]),/permission denied/);
 await assert.rejects(()=>f.db.query("update public.group_members set role='organiser' where user_id=$1",[f.outsider]),/permission denied/);
 await assert.rejects(()=>f.db.query('select * from public.invitations'),/permission denied/);
});

test('guest expenses, corrections, refunds, shopping and both repayment directions remain group-scoped',async t=>{
 const f=await privacyFixture(t);await joinGuest(f);
 const input=f.expenseInput({group:f.trip,payer:f.outsider,people:[f.a,f.outsider],amount:1200});
 const expense=await f.save(f.outsider,input);
 assert.equal(await f.save(f.outsider,input),expense);
 const correction=f.expenseInput({group:f.trip,payer:f.outsider,people:[f.a,f.outsider],amount:1000});
 const replacement=await f.save(f.outsider,correction,expense,1);
 const refund=await f.call(f.outsider,'refund_expense',[f.trip,replacement,200,'Synthetic trip refund',randomUUID()]);
 assert.ok(refund);
 const payment=await f.call(f.a,'record_repayment',[f.trip,f.outsider,'sent',300,'2026-11-01','',false,randomUUID()]);
 const receipt=await f.call(f.outsider,'record_repayment',[f.trip,f.a,'received',100,'2026-11-01','',false,randomUUID()]);
 assert.ok(payment&&receipt);
 const shopping=await f.call(f.outsider,'add_shopping_item',[f.trip,'Picnic supplies',1,'bag','',false,randomUUID()]);
 assert.ok(shopping);
 const state=await f.call(f.outsider,'get_group_snapshot',[f.trip]);
 assert.equal(state.balances.reduce((sum:number,row:any)=>sum+Number(row.cents),0),0);
 assert.equal(state.expenses.length,2);assert.equal(state.refunds.length,1);assert.equal(state.payments.length,2);
 await assert.rejects(()=>f.save(f.outsider,f.expenseInput({group:f.home,payer:f.outsider,people:[f.a]})),/forbidden/);
 await assert.rejects(()=>f.save(f.outsider,f.expenseInput({group:f.trip,payer:f.outsider,people:[f.c]})),/invalid_split/);
 await assert.rejects(()=>f.call(f.outsider,'record_repayment',[f.trip,f.c,'sent',100,'2026-11-01','',false,randomUUID()]),/invalid_payment/);
 await action(f,f.a,f.trip,'remove_member',f.outsider);
 assert.equal(await f.save(f.outsider,input),expense,'an uncertain completed request can still reconcile its ID after removal');
 await assert.rejects(()=>f.save(f.outsider,f.expenseInput({group:f.trip,payer:f.outsider,people:[f.a]})),/forbidden/);
 assert.equal((await f.call(f.a,'get_group_snapshot',[f.trip])).expenses.length,2,'removal retains financial history');
});

test('trip-only organisers can invite but cannot enumerate or add people from the household directory',async t=>{
 const f=await privacyFixture(t);await joinGuest(f);
 await assert.rejects(()=>invite(f,f.outsider,'person2@example.test'),/forbidden/);
 assert.deepEqual((await f.call(f.outsider,'get_household_state',[f.trip,50])).invitations,[]);
 await action(f,f.a,f.trip,'make_organiser',f.outsider);
 await assert.rejects(()=>f.call(f.outsider,'get_household_state',[f.home,1]),/forbidden/);
 await assert.rejects(()=>f.call(f.outsider,'create_space',['Unauthorized trip','trip',f.home,[],randomUUID()]),/forbidden/);
 await assert.rejects(()=>action(f,f.outsider,f.trip,'add_trip_member',f.c),/forbidden/);
 await assert.rejects(()=>invite(f,f.outsider,'person2@example.test',f.home),/forbidden/);
 const token=await invite(f,f.outsider,'person2@example.test');
 assert.equal(await membership(f,f.c),undefined,'known account is not enrolled without accepting');
 await f.call(f.c,'accept_invitation',[token]);
 assert.deepEqual(await membership(f,f.c),{role:'member',status:'active',access_basis:'direct'});
 await action(f,f.a,f.home,'remove_member',f.c);
 assert.equal((await membership(f,f.c)).status,'revoked','household removal also cascades a direct trip membership for that same person');
 const unknown=await invite(f,f.outsider,'not-registered@example.test');assert.equal(unknown.length,64,'creating links does not reveal whether the address already has an account');
 await action(f,f.a,f.trip,'remove_member',f.outsider);
 const next=await invite(f);await f.call(f.outsider,'accept_invitation',[next]);
 assert.equal((await membership(f,f.outsider)).role,'member','rejoining cannot recover a former organiser role');
});

test('wrong-account, unverified, expired, replaced, revoked and archived invitations cannot enroll a guest',async t=>{
 const f=await privacyFixture(t);let token=await invite(f);
 await assert.rejects(()=>f.call(f.c,'accept_invitation',[token]),/invalid_invitation/);
 await assert.rejects(()=>f.call(f.unverified,'accept_invitation',[token]),/unauthenticated/);
 const replacement=await invite(f);await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[token]),/invalid_invitation/);
 await f.admin();await f.db.query("update public.invitations set expires_at=now()-interval '1 second' where group_id=$1 and revoked_at is null",[f.trip]);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[replacement]),/invalid_invitation/);
 token=await invite(f);const pending=(await f.call(f.a,'get_household_state',[f.trip,50])).invitations[0];
 await action(f,f.a,f.trip,'revoke_invitation',pending.id);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[token]),/invalid_invitation/);
 token=await invite(f);await action(f,f.a,f.trip,'archive',null);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[token]),/invalid_invitation/);
 await assert.rejects(()=>invite(f),/forbidden/);
 assert.equal(await membership(f,f.outsider),undefined);
});

test('household removal keeps cascading, invalidates old links and does not upgrade an active membership',async t=>{
 const f=await privacyFixture(t);
 await action(f,f.a,f.trip,'make_organiser',f.b);
 const existing=await invite(f,f.a,'person1@example.test');await f.call(f.b,'accept_invitation',[existing]);
 assert.deepEqual(await membership(f,f.b),{role:'organiser',status:'active',access_basis:'household'},'direct links do not silently upgrade an active household-linked member');
 const pending=await invite(f,f.a,'person1@example.test');
 const fromRemovedOrganiser=await invite(f,f.b);
 await action(f,f.a,f.home,'remove_member',f.b);
 assert.equal((await membership(f,f.b)).status,'revoked');
 for(const token of [existing,pending])await assert.rejects(()=>f.call(f.b,'accept_invitation',[token]),/invalid_invitation/);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[fromRemovedOrganiser]),/invalid_invitation/);
 await f.admin();await f.db.query("update public.group_members set status='active' where group_id=$1 and user_id=$2",[f.trip,f.b]);
 await assert.rejects(()=>f.call(f.b,'get_household_state',[f.trip,50]),/forbidden/,'orphan household-linked membership still grants no access');
 await assert.rejects(()=>f.save(f.a,f.expenseInput({group:f.trip,people:[f.b]})),/invalid_split/);
 await assert.rejects(()=>f.call(f.a,'record_repayment',[f.trip,f.b,'sent',100,'2026-11-01','',false,randomUUID()]),/invalid_payment/);
 await f.admin();await f.db.query("update public.group_members set status='revoked' where group_id=$1 and user_id=$2",[f.trip,f.b]);
 const fresh=await invite(f,f.a,'person1@example.test');await f.call(f.b,'accept_invitation',[fresh]);
 assert.deepEqual(await membership(f,f.b),{role:'member',status:'active',access_basis:'direct'},'a fresh invitation can deliberately admit the former flatmate to this trip only');
 await assert.rejects(()=>f.call(f.b,'get_household_state',[f.home,50]),/forbidden/);
});

test('acceptance rechecks organiser authority even if the pending invitation was not explicitly revoked',async t=>{
 const f=await privacyFixture(t);await action(f,f.a,f.trip,'make_organiser',f.b);
 const token=await invite(f,f.b);
 await f.admin();await f.db.query("update public.group_members set role='member' where group_id=$1 and user_id=$2",[f.trip,f.b]);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[token]),/invalid_invitation/);
 assert.equal(await membership(f,f.outsider),undefined);
});

test('trip photos and alerts use effective guest access and stop immediately after trip removal',async t=>{
 const f=await privacyFixture(t);await joinGuest(f);
 const photo=(actor:string,kind:string,request:string|null=null,digest:string|null=null,target:string|null=null)=>f.worker('profile_photo_action',[actor,kind,request,null,digest,target]);
 const request=randomUUID(),digest='a'.repeat(64),slot=await photo(f.outsider,'reserve',request,digest);
 await f.admin();await f.db.query("insert into storage.objects(bucket_id,name,metadata) values('profile-photos',$1,$2)",[slot.object_path,JSON.stringify({size:100,mimetype:'image/jpeg'})]);
 await photo(f.outsider,'complete',request,digest);
 assert.equal((await photo(f.a,'read',null,null,f.outsider)).status,'ready');
 await assert.rejects(()=>photo(f.c,'read',null,null,f.outsider),/photo_not_found/,'household members outside the trip do not gain guest photo access');
 const subscription=await f.register(f.outsider);await f.register(f.c);
 const expense=await f.save(f.a,f.expenseInput({group:f.trip,people:[f.outsider]}));
 const outbox=await f.rows('select id,user_id,subscription_id from private.notification_outbox where entity_id=$1',[expense]);
 assert.deepEqual(outbox.map(row=>[row.user_id,row.subscription_id]),[[f.outsider,subscription.id]]);
 assert.equal((await f.call(f.outsider,'resolve_notification',[outbox[0].id])).household,f.trip);
 const claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);
 assert.ok(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]));
 await action(f,f.a,f.trip,'remove_member',f.outsider);
 assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null);
 await assert.rejects(()=>f.call(f.outsider,'resolve_notification',[outbox[0].id]),/notification_unavailable/);
 await assert.rejects(()=>photo(f.a,'read',null,null,f.outsider),/photo_not_found/);
 assert.equal((await photo(f.outsider,'read')).status,'ready','group removal does not delete the owner photo');
});

async function baselineFixture(t:TestContext,receivedPayments=false){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 await db.exec(await readFile('tests/fixtures/platform.sql','utf8'));
 const baseline=['20261004024901_foundation.sql','20261004025331_relationship_indexes.sql','20261005071001_household_workflows.sql','20261006062916_editable_profiles.sql','20261011083917_private_profile_photos.sql'];
 for(const file of baseline)await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 if(receivedPayments)await db.exec(await readFile('supabase/migrations/20261011030705_received_repayments.sql','utf8'));
 const a=randomUUID(),b=randomUUID(),guest=randomUUID();
 for(const [id,email] of [[a,'host@example.test'],[b,'member@example.test'],[guest,'guest@example.test']])await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
 async function as(actor:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');}
 async function call(actor:string,name:string,args:unknown[]=[]):Promise<any>{await as(actor);return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;}
 return {db,a,b,guest,as,call};
}

test('the migration upgrades the photo-only production baseline without installing optional modules',async t=>{
 const f=await baselineFixture(t);
 const home=await f.call(f.a,'create_space',['Synthetic home','household',null,[],randomUUID()]);
 const homeLink=await f.call(f.a,'create_invitation',[home,'member@example.test']);await f.call(f.b,'accept_invitation',[homeLink]);
 const trip=await f.call(f.a,'create_space',['Synthetic trip','trip',home,[],randomUUID()]);
 const oldLink=await f.call(f.a,'create_invitation',[trip,'member@example.test']);
 await f.db.exec('reset role');await f.db.exec(await readFile('supabase/migrations/20261101014329_direct_trip_invitations.sql','utf8'));
 await f.db.query("update public.group_members set status='revoked' where group_id=$1 and user_id=$2",[home,f.b]);
 await assert.rejects(()=>f.call(f.b,'accept_invitation',[oldLink]),/trip_member_must_belong_to_household/,'old pending links retain their household restriction');
 await f.db.exec('reset role');await f.db.query("update public.group_members set status='active' where group_id=$1 and user_id=$2",[home,f.b]);
 await f.call(f.b,'accept_invitation',[oldLink]);
 await f.db.exec('reset role');
 assert.equal((await f.db.query<{access_basis:string}>('select access_basis from public.group_members where group_id=$1 and user_id=$2',[trip,f.b])).rows[0].access_basis,'household');
 const absent=await f.db.query<{notifications:string|null;repayments:string|null}>("select to_regclass('private.notification_outbox')::text as notifications,to_regprocedure('private.insert_repayment(uuid,uuid,text,bigint,date,text,boolean)')::text as repayments");
 assert.deepEqual(absent.rows[0],{notifications:null,repayments:null});
 const token=await f.call(f.a,'create_invitation',[trip,'guest@example.test']);await f.call(f.guest,'accept_invitation',[token]);
 const expense=await f.call(f.guest,'create_expense',[trip,randomUUID(),'Synthetic transport',1000,f.guest,[f.guest,f.a],'equal',null,'2026-11-01','travel','']);assert.ok(expense);
 const payment=await f.call(f.a,'record_payment',[trip,f.guest,500,'2026-11-01','',randomUUID()]);
 await f.call(f.guest,'payment_action',[trip,payment,'confirm',1,'',randomUUID()]);
 assert.equal((await f.call(f.guest,'get_group_snapshot',[trip])).payments[0].status,'confirmed');
 await assert.rejects(()=>f.call(f.guest,'get_household_state',[home,1]),/forbidden/);
});

test('optional receipt recording also supports guests before payment preferences are installed',async t=>{
 const f=await baselineFixture(t,true);
 const home=await f.call(f.a,'create_space',['Synthetic home','household',null,[],randomUUID()]);
 const trip=await f.call(f.a,'create_space',['Synthetic trip','trip',home,[],randomUUID()]);
 await f.db.exec('reset role');await f.db.exec(await readFile('supabase/migrations/20261101014329_direct_trip_invitations.sql','utf8'));
 const token=await f.call(f.a,'create_invitation',[trip,'guest@example.test']);await f.call(f.guest,'accept_invitation',[token]);
 const sent=await f.call(f.a,'record_repayment',[trip,f.guest,'sent',400,'2026-11-01','',false,randomUUID()]);
 await f.call(f.guest,'payment_action',[trip,sent,'confirm',1,'',randomUUID()]);
 const received=await f.call(f.guest,'record_repayment',[trip,f.a,'received',100,'2026-11-01','',false,randomUUID()]);
 const state=await f.call(f.guest,'get_group_snapshot',[trip]);
 assert.equal(state.payments.find((p:any)=>p.id===received).status,'confirmed');
 assert.equal(state.payments.find((p:any)=>p.id===sent).status,'confirmed');
 await f.db.exec('reset role');
 assert.equal((await f.db.query<{count:number}>("select count(*)::integer from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='require_payment_approval'")).rows[0].count,0,'compatibility does not install preferences');
});

test('last-organiser protection counts effective access, not orphan active membership rows',async t=>{
 const f=await privacyFixture(t);await action(f,f.a,f.trip,'make_organiser',f.b);
 await f.admin();await f.db.query("update public.group_members set status='revoked' where group_id=$1 and user_id=$2",[f.home,f.b]);
 await assert.rejects(()=>action(f,f.a,f.trip,'remove_member',f.a),/last_organiser/);
});

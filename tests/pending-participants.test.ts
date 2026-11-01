import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {privacyFixture,type PrivacyFixture} from './privacyFixture';

const token=()=>randomBytes(32).toString('hex');
const pending=(f:PrivacyFixture,email='person4@example.test',group=f.trip,request=randomUUID(),secret=token())=>
 f.call<any>(f.a,'add_pending_participant',[group,'Invited friend',email,request,secret]);
const state=(f:PrivacyFixture,actor=f.a,group=f.trip)=>f.call<any>(actor,'get_group_state_v4',[group,10000]);
async function claim(f:PrivacyFixture,link:string,actor=f.outsider){const preview=await f.call<any>(actor,'get_invitation_preview',[link]);return f.call(actor,'accept_invitation_v2',[link,preview.review_digest]);}

test('include now creates only a group ledger identity; link retries and replacements keep the same identity',async t=>{
 const f=await privacyFixture(t),request=randomUUID(),secret=token(),before=(await f.rows('select count(*)::integer n from public.profiles'))[0].n;
 const first=await pending(f,undefined,undefined,request,secret),again=await pending(f,undefined,undefined,request,secret);
 assert.deepEqual(again,first);assert.equal(first.token,secret);assert.notEqual(first.participant_id,f.outsider);
 assert.equal((await f.rows('select count(*)::integer n from public.profiles'))[0].n,before);
 assert.equal((await f.rows('select user_id from public.group_members where group_id=$1 and user_id=$2',[f.trip,f.outsider])).length,0);
 assert.equal((await f.rows('select to_jsonb(i)::text data from public.invitations i where id=$1',[first.invitation_id]))[0].data.includes(secret),false,'only a one-way token hash is stored');
 const view=await state(f),p=view.members.find((m:any)=>m.id===first.participant_id);
 assert.equal(view.schema_version,4);assert.equal(view.my_participant_id,f.a);
 assert.deepEqual([p.auth_user_id,p.status,p.can_select,p.can_repay],[null,'invited',true,false]);
 await assert.rejects(()=>f.call(f.outsider,'get_group_state_v4',[f.trip]),/forbidden/);
 await assert.rejects(()=>f.call(f.a,'get_household_state',[f.trip,50]),/client_update_required/);
 await assert.rejects(()=>pending(f,undefined,undefined,request,token()),/idempotency_conflict/);
 const replacement=await pending(f);assert.equal(replacement.participant_id,first.participant_id);assert.notEqual(replacement.invitation_id,first.invitation_id);
 await assert.rejects(()=>f.call(f.outsider,'get_invitation_preview',[secret]),/invalid_invitation/);
 assert.equal((await f.rows('select id from public.group_participants where group_id=$1 and auth_user_id is null',[f.trip])).length,1);
 await f.as(f.a);await assert.rejects(()=>f.db.query('select * from private.participant_contacts'),/permission denied/);
 await assert.rejects(()=>f.db.query('insert into public.group_participants(group_id,id,display_name,created_by) values($1,$2,$3,$4)',[f.trip,randomUUID(),'Fake',f.a]),/permission denied/);
});

test('a person who has not registered can claim only their own prepared identity after Google signup',async t=>{
 const f=await privacyFixture(t),invite=await pending(f,'new-friend@example.test'),newUser=randomUUID();
 await f.save(f.a,f.expenseInput({group:f.trip,people:[invite.participant_id],amount:345}));
 assert.equal((await f.rows("select id from auth.users where email='new-friend@example.test'")).length,0);
 await f.admin();
 await f.db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,'new-friend@example.test',now(),'{\"full_name\":\"New friend\"}')",[newUser]);
 const preview=await f.call<any>(newUser,'get_invitation_preview',[invite.token]);
 assert.equal(preview.net_cents,-345);
 await f.call(newUser,'accept_invitation_v2',[invite.token,preview.review_digest]);
 const view=await state(f,newUser);assert.equal(view.my_participant_id,invite.participant_id);
 assert.equal(view.members.find((m:any)=>m.id===invite.participant_id).auth_user_id,newUser);
 assert.equal(view.balances.find((b:any)=>b.user_id===invite.participant_id).cents,-345);
 assert.equal(view.members.some((m:any)=>m.id===newUser),false,'signup does not create a second ledger identity');
});

test('pending people can pay and share exact expenses; joining preserves every ledger ID and cent',async t=>{
 const f=await privacyFixture(t),invite=await pending(f),party=invite.participant_id;
 const expense=await f.save(f.a,{...f.expenseInput({group:f.trip,payer:party,people:[f.a,party],amount:1001}),p_mode:'exact',p_exact:{[f.a]:400,[party]:601}});
 await f.call(f.a,'refund_expense',[f.trip,expense,101,'Synthetic partial refund',randomUUID()]);
 const before=await state(f);assert.equal(before.balances.reduce((n:number,b:any)=>n+b.cents,0),0);
 await assert.rejects(()=>f.call(f.a,'record_repayment',[f.trip,party,'sent',100,'2026-11-01','',false,randomUUID()]),/invalid_payment/);
 await assert.rejects(()=>f.call(f.c,'get_invitation_preview',[invite.token]),/invalid_invitation/);
 await assert.rejects(()=>f.call(f.unverified,'get_invitation_preview',[invite.token]),/unauthenticated/);
 const preview=await f.call<any>(f.outsider,'get_invitation_preview',[invite.token]);
 assert.equal(preview.expense_count,1);assert.equal(preview.paid_cents,900);assert.equal(preview.net_cents,before.balances.find((b:any)=>b.user_id===party).cents);
 assert.equal('members' in preview,false);assert.equal('expenses' in preview,false);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation',[invite.token]),/invitation_review_required/);
 assert.equal(await f.call(f.outsider,'accept_invitation_v2',[invite.token,preview.review_digest]),f.trip);
 assert.equal(await f.call(f.outsider,'accept_invitation_v2',[invite.token,preview.review_digest]),f.trip,'lost acceptance response is safe to retry');
 const after=await state(f,f.outsider);assert.equal(after.my_participant_id,party);
 assert.deepEqual(after.balances,before.balances);assert.deepEqual(after.expenses,before.expenses);assert.deepEqual(after.shares,before.shares);assert.deepEqual(after.refund_shares,before.refund_shares);
 const joined=after.members.find((m:any)=>m.id===party);assert.equal(joined.auth_user_id,f.outsider);assert.equal(joined.name,'Outside');assert.equal(joined.can_repay,true);assert.equal(joined.status,'active');
 assert.equal((await f.rows('select user_id from public.group_members where group_id=$1 and user_id=$2',[f.home,f.outsider])).length,0,'trip claim never enrolls a household');
 assert.equal((await f.rows('select created_by from public.expenses where id=$1',[expense]))[0].created_by,f.a,'record attribution is not reassigned to claimant');
 const pay=await f.call(f.outsider,'record_repayment',[f.trip,f.a,'received',100,'2026-11-01','',false,randomUUID()]);
 const payment=(await state(f,f.outsider)).payments.find((p:any)=>p.id===pay);assert.equal(payment.recipient_id,party);assert.equal(payment.recorded_by,f.outsider);assert.equal(payment.status,'confirmed');
 await f.call(f.outsider,'payment_action',[f.trip,pay,'reverse',1,'Correct synthetic transfer',randomUUID()]);
});

test('account aliases, repayment preferences and action permissions use the joined participant mapping',async t=>{
 const f=await privacyFixture(t),invite=await pending(f);await claim(f,invite.token);const party=invite.participant_id;
 const id=await f.save(f.outsider,{...f.expenseInput({group:f.trip,payer:f.outsider,people:[f.a,f.outsider],amount:100}),p_mode:'exact',p_exact:{[f.a]:40,[f.outsider]:60}});
 let view=await state(f,f.outsider);assert.equal(view.expenses.find((e:any)=>e.id===id).cash_actor_id,party);assert.equal(view.shares.find((s:any)=>s.expense_id===id&&s.user_id===party).share_cents,60);
 await assert.rejects(()=>f.save(f.a,f.expenseInput({group:f.trip,people:[party,f.outsider]})),/invalid_split/,'two aliases cannot charge one party twice');
 await assert.rejects(()=>f.save(f.a,{...f.expenseInput({group:f.trip,people:[party],amount:100}),p_mode:'exact',p_exact:{[party]:100,[f.outsider]:100}}),/invalid_split/,'two exact keys for one party cannot silently collapse');
 await f.call(f.outsider,'set_payment_preferences',[true]);
 const pay=await f.call(f.a,'record_repayment',[f.trip,party,'sent',40,'2026-11-01','',false,randomUUID()]);
 view=await state(f);assert.equal(view.payments.find((p:any)=>p.id===pay).status,'pending');
 await assert.rejects(()=>f.call(f.b,'payment_action',[f.trip,pay,'confirm',1,'',randomUUID()]),/invalid_action/);
 await f.call(f.outsider,'payment_action',[f.trip,pay,'confirm',1,'',randomUUID()]);
 assert.equal((await state(f)).payments.find((p:any)=>p.id===pay).status,'confirmed');
 await f.call(f.a,'group_action',[f.trip,'remove_member',f.outsider,'',randomUUID()]);
 view=await state(f);assert.equal(view.members.find((m:any)=>m.id===party).can_select,false);assert.equal(view.members.find((m:any)=>m.id===party).can_repay,false);
 assert.ok(view.expenses.some((e:any)=>e.id===id));await assert.rejects(()=>state(f,f.outsider),/forbidden/);
});

test('acceptance requires an unchanged own-record preview and cannot merge separate financial identities',async t=>{
 const f=await privacyFixture(t),invite=await pending(f),preview=await f.call<any>(f.outsider,'get_invitation_preview',[invite.token]);
 await f.save(f.a,f.expenseInput({group:f.trip,people:[invite.participant_id],amount:500}));
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation_v2',[invite.token,preview.review_digest]),/invitation_preview_changed/);
 assert.equal((await f.rows('select auth_user_id from public.group_participants where group_id=$1 and id=$2',[f.trip,invite.participant_id]))[0].auth_user_id,null);
 await f.admin();await assert.rejects(()=>f.db.query('insert into public.group_members(group_id,user_id,role) values($1,$2,$3)',[f.trip,f.outsider,'member']),/participant_invitation_required/);
 // An imported/corrupted second identity must fail closed, not silently merge.
 await f.db.query("insert into public.group_participants(group_id,id,auth_user_id,display_name,created_by,joined_at) values($1,$2,$2,'Separate identity',$3,now())",[f.trip,f.outsider,f.a]);
 await assert.rejects(()=>claim(f,invite.token),/participant_conflict/);
 const view=await state(f);assert.equal(view.balances.find((b:any)=>b.user_id===invite.participant_id).cents,-500);
});

test('expired or revoked invitations stop new selection without deleting expenses; reissue reactivates the same party',async t=>{
 const f=await privacyFixture(t),invite=await pending(f),party=invite.participant_id;
 const expense=await f.save(f.a,f.expenseInput({group:f.trip,people:[party],amount:100}));
 await f.admin();await f.db.query("update public.invitations set expires_at=clock_timestamp()-interval '1 second' where id=$1",[invite.invitation_id]);
 let view=await state(f);assert.equal(view.members.find((m:any)=>m.id===party).status,'expired');assert.equal(view.members.find((m:any)=>m.id===party).can_select,false);
 await assert.rejects(()=>f.save(f.a,f.expenseInput({group:f.trip,people:[party]})),/invalid_split/);
 await f.call(f.a,'refund_expense',[f.trip,expense,10,'Synthetic refund after expiry',randomUUID()]);
 const fresh=await f.call<string>(f.a,'create_invitation',[f.trip,'person4@example.test']);
 assert.equal((await f.call<any>(f.outsider,'get_invitation_preview',[fresh])).participant_id,party);
 view=await state(f);assert.equal(view.members.find((m:any)=>m.id===party).can_select,true);assert.equal(view.balances.find((b:any)=>b.user_id===party).cents,-90);
 const inv=(await f.rows('select id from public.invitations where group_id=$1 and participant_id=$2 and revoked_at is null and expires_at>now()',[f.trip,party]))[0];
 await f.call(f.a,'group_action',[f.trip,'revoke_invitation',inv.id,'',randomUUID()]);
 assert.equal((await state(f)).members.find((m:any)=>m.id===party).can_select,false);await assert.rejects(()=>claim(f,fresh),/invalid_invitation/);
});

test('household claims preserve access boundaries and deny anonymous, member and direct-table bypasses',async t=>{
 const f=await privacyFixture(t),invite=await pending(f,undefined,f.home);
 await assert.rejects(()=>f.call(f.b,'add_pending_participant',[f.home,'Nobody','new@example.test',randomUUID(),token()]),/forbidden/);
 await assert.rejects(()=>f.call(f.outsider,'add_pending_participant',[f.home,'Nobody','new@example.test',randomUUID(),token()]),/forbidden/);
 await f.as(f.a);
 await assert.rejects(()=>f.db.query('select private.participant_auth_user($1,$2)',[f.home,invite.participant_id]),/permission denied/);
 await assert.rejects(()=>f.db.query('select * from public.group_participants'),/permission denied/);
 await f.admin();await f.db.exec('set role anon');
 await assert.rejects(()=>f.rpc('get_invitation_preview',[invite.token]),/permission denied/);
 await assert.rejects(()=>f.rpc('accept_invitation_v2',[invite.token,'0'.repeat(64)]),/permission denied/);
 await assert.rejects(()=>f.rpc('get_group_state_v4',[f.home]),/permission denied/);
 await claim(f,invite.token);
 assert.equal((await state(f,f.outsider,f.home)).my_participant_id,invite.participant_id);
 await assert.rejects(()=>state(f,f.outsider,f.trip),/forbidden/,'joining a household does not enroll its existing trips');
 await f.call(f.a,'group_action',[f.home,'archive',null,'',randomUUID()]);
 const archived=await state(f,f.a,f.home);
 assert.ok(archived.members.every((m:any)=>!m.can_select&&!m.can_repay));
 await assert.rejects(()=>pending(f,'another@example.test',f.home),/forbidden/);
});

test('same-value corrections change the invitation review without exposing another person’s records',async t=>{
 const f=await privacyFixture(t),invite=await pending(f);
 const original=await f.save(f.a,f.expenseInput({group:f.trip,people:[invite.participant_id],amount:500}));
 const before=await f.call<any>(f.outsider,'get_invitation_preview',[invite.token]);
 await f.save(f.a,f.expenseInput({group:f.trip,people:[f.a,f.b],amount:900}));
 assert.equal((await f.call<any>(f.outsider,'get_invitation_preview',[invite.token])).review_digest,before.review_digest,'unrelated purchases are outside the invitee review');
 await f.save(f.a,{...f.expenseInput({group:f.trip,people:[invite.participant_id],amount:500}),p_description:'Corrected synthetic title'},original,1);
 const after=await f.call<any>(f.outsider,'get_invitation_preview',[invite.token]);
 assert.equal(after.net_cents,before.net_cents);assert.notEqual(after.review_digest,before.review_digest);
 await assert.rejects(()=>f.call(f.outsider,'accept_invitation_v2',[invite.token,before.review_digest]),/invitation_preview_changed/);
 await f.call(f.outsider,'accept_invitation_v2',[invite.token,after.review_digest]);
});

async function legacyFixture(t:TestContext,receivedPayments:boolean){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 const files=['20261004024901_foundation.sql','20261004025331_relationship_indexes.sql','20261005071001_household_workflows.sql','20261006062916_editable_profiles.sql'];
 if(receivedPayments)files.push('20261011030705_received_repayments.sql');
 files.push('20261101014329_direct_trip_invitations.sql');
 for(const file of files)await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const host=randomUUID(),member=randomUUID(),guest=randomUUID();
 for(const [id,email] of [[host,'host@example.test'],[member,'member@example.test'],[guest,'guest@example.test']])await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
 async function call(actor:string,name:string,args:unknown[]=[]):Promise<any>{
  assert.match(name,/^[a-z][a-z0-9_]*$/);await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');
  return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;
 }
 return {db,host,member,guest,call};
}

for(const receipts of [false,true])test(`pending identities upgrade existing ledger data with ${receipts?'receipt recording but no preferences':'legacy payments and no optional modules'}`,async t=>{
 const f=await legacyFixture(t,receipts),group=await f.call(f.host,'create_space',['Synthetic home','household',null,[],randomUUID()]);
 const memberLink=await f.call(f.host,'create_invitation',[group,'member@example.test']);await f.call(f.member,'accept_invitation',[memberLink]);
 await f.call(f.host,'create_expense',[group,randomUUID(),'Existing expense',999,f.host,[f.host,f.member],'equal',null,'2026-11-01','groceries','']);
 const oldPayment=await f.call(f.member,'record_payment',[group,f.host,100,'2026-11-01','',randomUUID()]);
 const before=await f.call(f.host,'get_household_state',[group,50]);
 await f.db.exec('reset role');await f.db.exec(await readFile('supabase/migrations/20261101031522_pending_group_participants.sql','utf8'));
 assert.deepEqual(await f.call(f.host,'get_household_state',[group,50]),before,'ordinary groups keep their legacy snapshot and financial rows');
 const added=await f.call(f.host,'add_pending_participant',[group,'Future member','guest@example.test',randomUUID(),token()]);
 const expense=await f.call(f.host,'create_expense',[group,randomUUID(),'Pending expense',101,added.participant_id,[f.host,added.participant_id],'equal',null,'2026-11-01','groceries','']);
 const preview=await f.call(f.guest,'get_invitation_preview',[added.token]);
 await f.call(f.guest,'accept_invitation_v2',[added.token,preview.review_digest]);
 const pay=await f.call(f.host,'record_payment',[group,added.participant_id,10,'2026-11-01','',randomUUID()]);
 await f.call(f.guest,'payment_action',[group,pay,'confirm',1,'',randomUUID()]);
 await f.call(f.host,'payment_action',[group,oldPayment,'confirm',1,'',randomUUID()]);
 const view=await f.call(f.guest,'get_group_state_v4',[group,50]);
 assert.equal(view.my_participant_id,added.participant_id);assert.equal(view.expenses.find((e:any)=>e.id===expense).cash_actor_id,added.participant_id);
 assert.equal(view.payments.find((p:any)=>p.id===pay).status,'confirmed');assert.equal(view.balances.reduce((n:number,b:any)=>n+b.cents,0),0);
 if(receipts){const received=await f.call(f.guest,'record_repayment',[group,f.host,'received',5,'2026-11-01','',false,randomUUID()]);assert.equal((await f.call(f.guest,'get_group_state_v4',[group,50])).payments.find((p:any)=>p.id===received).recorded_by,f.guest);}
 await f.db.exec('reset role');
 assert.equal((await f.db.query<{missing:boolean}>("select to_regclass('private.notification_outbox') is null and not exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname='require_payment_approval' and not attisdropped) as missing")).rows[0].missing,true,'upgrade does not introduce optional modules');
});

test('the rollback-only hosted smoke script runs locally and leaves no fixture data',async t=>{
 const f=await privacyFixture(t);await f.admin();
 await f.db.exec('alter table auth.users add column aud text,add column role text');
 const before=await f.rows('select count(*)::integer n from auth.users');
 await f.db.exec(await readFile('tests/pending-participants-hosted.sql','utf8'));
 assert.deepEqual(await f.rows('select count(*)::integer n from auth.users'),before);
 assert.equal((await f.rows("select id from public.groups where name like 'QA pending%'")).length,0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {privacyFixture,type PrivacyFixture} from './privacyFixture';

const compatibilityPath='supabase/migrations/20261101031706_participant_notification_compatibility.sql';
async function pendingGuest(f:PrivacyFixture){
 const token=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 const added=await f.call<{participant_id:string;token:string}>(f.a,'add_pending_participant',
  [f.trip,'Invited friend','person4@example.test',randomUUID(),token]);
 assert.notEqual(added.participant_id,f.outsider);assert.equal(added.token,token);
 return added;
}
async function joinGuest(f:PrivacyFixture,token:string){
 const preview=await f.call<{review_digest:string}>(f.outsider,'get_invitation_preview',[token]);
 assert.equal(await f.call(f.outsider,'accept_invitation_v2',[token,preview.review_digest]),f.trip);
}
const outboxFor=(f:PrivacyFixture,entity:string)=>f.rows<{user_id:string;actor_id:string;category:string}>(
 'select user_id,actor_id,category from private.notification_outbox where entity_id=$1 order by user_id',[entity]);

test('participant notification compatibility leaves an absent optional module absent',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec('create schema private');
 await db.exec(await readFile(compatibilityPath,'utf8'));
 const result=await db.query<{tables:number;functions:number}>(`
  select (select count(*)::integer from pg_tables where schemaname='private') as tables,
   (select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private') as functions
 `);
 assert.deepEqual(result.rows,[{tables:0,functions:0}]);
});

test('participant notification compatibility refuses an installed module without the core mapping',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(`create schema private;
  create function private.enqueue_transaction_notifications() returns trigger language plpgsql as $$begin return new;end$$;`);
 await assert.rejects(async()=>db.exec(await readFile(compatibilityPath,'utf8')),/participant_migration_required/);
});

test('pending expenses stay quiet for invitees; claiming never replays history and future activity reaches the real account',async t=>{
 const f=await privacyFixture(t);for(const who of [f.a,f.b,f.outsider])await f.register(who);
 const guest=await pendingGuest(f);
 const expense=await f.save(f.a,f.expenseInput({group:f.trip,people:[f.b,guest.participant_id]}));
 assert.deepEqual((await outboxFor(f,expense)).map(n=>n.user_id),[f.b]);
 const refund=await f.call<string>(f.a,'refund_expense',[f.trip,expense,100,'Synthetic refund',randomUUID()]);
 assert.deepEqual((await outboxFor(f,refund)).map(n=>n.user_id),[f.b]);
 const before=(await f.rows('select id from private.notification_outbox')).length;
 await joinGuest(f,guest.token);
 assert.equal((await f.rows('select id from private.notification_outbox')).length,before,'claim emits no historical financial push');
 const future=await f.save(f.a,f.expenseInput({group:f.trip,people:[f.b,guest.participant_id]}));
 const actual=await outboxFor(f,future);
 assert.deepEqual(actual.map(n=>n.user_id).sort(),[f.b,f.outsider].sort());
 assert.ok(actual.every(n=>n.actor_id===f.a&&n.category==='expenses'));
 assert.equal((await f.rows('select id from private.notification_outbox where user_id=$1',[guest.participant_id])).length,0);
});

test('claimed participant actor exclusion and correction/refund unions resolve stable ledger IDs once',async t=>{
 const f=await privacyFixture(t);for(const who of [f.a,f.b,f.outsider])await f.register(who);
 const guest=await pendingGuest(f);await joinGuest(f,guest.token);
 const original=await f.save(f.outsider,f.expenseInput({group:f.trip,payer:guest.participant_id,people:[f.a,guest.participant_id]}));
 assert.deepEqual((await outboxFor(f,original)).map(n=>n.user_id),[f.a],'auth actor must not receive a push via their different ledger ID');
 const corrected=await f.save(f.a,f.expenseInput({group:f.trip,people:[f.b]}),original,1);
 assert.deepEqual((await outboxFor(f,corrected)).map(n=>n.user_id).sort(),[f.b,f.outsider].sort(),'correction includes previous and new involved accounts');
 const refundable=await f.save(f.a,f.expenseInput({group:f.trip,payer:guest.participant_id,people:[f.b,guest.participant_id]}));
 const refund=await f.call<string>(f.a,'refund_expense',[f.trip,refundable,100,'Synthetic refund',randomUUID()]);
 assert.deepEqual((await outboxFor(f,refund)).map(n=>n.user_id).sort(),[f.b,f.outsider].sort());
 await f.call(f.a,'group_action',[f.trip,'make_organiser',f.outsider,'',randomUUID()]);
 await f.call(f.outsider,'void_refund',[f.trip,refund,'Synthetic correction',randomUUID()]);
 const rows=await f.rows<{user_id:string;action:string}>(`select n.user_id,a.action from private.notification_outbox n
  join public.activity_log a on a.id=n.activity_id where n.entity_id=$1 and a.action='refund_voided'`,[refund]);
 assert.deepEqual(rows.map(n=>n.user_id),[f.b],'refund actor exclusion uses the account identity');
});

test('repayment preferences and state changes address claimed accounts, never participant UUIDs',async t=>{
 const f=await privacyFixture(t);for(const who of [f.a,f.b,f.outsider])await f.register(who);
 const guest=await pendingGuest(f);
 await assert.rejects(()=>f.call(f.b,'record_repayment',[f.trip,guest.participant_id,'sent',500,'2026-11-01','Synthetic transfer',false,randomUUID()]),/invalid_payment/);
 await joinGuest(f,guest.token);await f.call(f.outsider,'set_payment_preferences',[true]);
 const payment=await f.call<string>(f.b,'record_repayment',[f.trip,guest.participant_id,'sent',500,'2026-11-01','Synthetic transfer',true,randomUUID()]);
 assert.deepEqual((await outboxFor(f,payment)).map(n=>n.user_id),[f.outsider]);
 const saved=(await f.rows<{sender_id:string;recipient_id:string;recorded_by:string;status:string}>(
  'select sender_id,recipient_id,recorded_by,status from public.payments where id=$1',[payment]))[0];
 assert.equal(saved.sender_id,f.b);assert.equal(saved.recipient_id,guest.participant_id);assert.equal(saved.recorded_by,f.b);assert.equal(saved.status,'pending');
 await f.call(f.outsider,'payment_action',[f.trip,payment,'confirm',1,'',randomUUID()]);
 await f.call(f.outsider,'payment_action',[f.trip,payment,'reverse',2,'Synthetic correction',randomUUID()]);
 const rows=await f.rows<{user_id:string;action:string}>(`select n.user_id,a.action from private.notification_outbox n
  join public.activity_log a on a.id=n.activity_id where n.entity_id=$1`,[payment]);
 assert.deepEqual(rows.map(n=>[n.action,n.user_id]).sort(),[['payment_recorded',f.outsider],['payment_confirmed',f.b],['payment_reversed',f.b]].sort());
 const received=await f.call<string>(f.outsider,'record_repayment',[f.trip,f.b,'received',400,'2026-11-01','Synthetic receipt',false,randomUUID()]);
 assert.deepEqual((await outboxFor(f,received)).map(n=>n.user_id),[f.b]);
});

test('claimed direct guests retain device, session and group revocation gates at delivery time',async t=>{
 const f=await privacyFixture(t);await f.register(f.outsider);
 const guest=await pendingGuest(f);await joinGuest(f,guest.token);
 const expense=await f.save(f.a,f.expenseInput({group:f.trip,people:[guest.participant_id]}));
 const queue=await outboxFor(f,expense);assert.equal(queue.length,1);assert.equal(queue[0].user_id,f.outsider);
 const claims=await f.worker<{id:string;lease_token:string}[]>('claim_notification_deliveries',[20]);assert.equal(claims.length,1);
 assert.ok(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]));
 await f.call(f.a,'group_action',[f.trip,'remove_member',f.outsider,'',randomUUID()]);
 assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null);
 await assert.rejects(()=>f.call(f.outsider,'resolve_notification',[claims[0].id]),/notification_unavailable/);
});

test('deferred notifications do not replay activity that predates a participant claim in the same transaction',async t=>{
 const f=await privacyFixture(t);await f.register(f.outsider);const guest=await pendingGuest(f);
 await f.as(f.a);await f.db.exec('begin');
 try{
  const expense=await f.rpc<string>('save_expense',[JSON.stringify(f.expenseInput({group:f.trip,people:[guest.participant_id]})),null,null,'',null]);
  await f.as(f.outsider);
  const preview=await f.rpc<{review_digest:string}>('get_invitation_preview',[guest.token]);
  await f.rpc('accept_invitation_v2',[guest.token,preview.review_digest]);
  await f.db.exec('commit');
  assert.deepEqual(await outboxFor(f,expense),[],'claim time must not become financial event time');
 }catch(error){await f.admin();await f.db.exec('rollback');throw error;}
});

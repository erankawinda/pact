import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyFixture} from './privacyFixture';

test('push registration is private, session-bound and rejects endpoint or ownership tampering',async t=>{
 const f=await privacyFixture(t);const device=await f.register(f.b);
 assert.deepEqual(await f.call(f.b,'get_push_subscription',[device.id]),{id:device.id,enabled:true});
 assert.deepEqual(await f.call(f.c,'get_push_subscription',[device.id]),{id:device.id,enabled:false});
 await assert.rejects(()=>f.call(f.c,'register_push_subscription',[device.id,device.endpoint,f.publicKey,f.auth,randomUUID()]),/push_device_conflict/);
 await f.call(f.c,'revoke_push_subscription',[device.id]);
 assert.equal((await f.call(f.b,'get_push_subscription',[device.id])).enabled,true,'another member cannot revoke this device');
 await f.as(f.b);
 for(const name of ['notification_preferences','push_subscriptions','notification_outbox'])await assert.rejects(()=>f.db.query(`select * from private.${name}`),/permission denied/);
 for(const [name,args] of [['claim_notification_deliveries',[20]],['get_notification_delivery',[randomUUID(),randomUUID()]],['finish_notification_delivery',[randomUUID(),randomUUID(),'sent',201,60]]] as const)await assert.rejects(()=>f.rpc(name,[...args]),/permission denied/);
 for(const endpoint of ['http://fcm.googleapis.com/fcm/send/a','https://localhost/secret','https://127.0.0.1/secret','https://fcm.googleapis.com.attacker.test/fcm/send/a','https://user@fcm.googleapis.com/fcm/send/a','https://fcm.googleapis.com/fcm/send/a?secret=1'])await assert.rejects(()=>f.call(f.b,'register_push_subscription',[randomUUID(),endpoint,f.publicKey,f.auth,randomUUID()]),/invalid_push_subscription/);
 await assert.rejects(()=>f.call(f.b,'register_push_subscription',[randomUUID(),`https://fcm.googleapis.com/fcm/send/${randomUUID()}`,'A'.repeat(87),f.auth,randomUUID()]),/invalid_push_subscription/);
 await f.as(f.b,null);await assert.rejects(()=>f.rpc('register_push_subscription',[randomUUID(),device.endpoint,f.publicKey,f.auth,randomUUID()]),/unauthenticated/);
 await f.as(f.b,f.sessions.get(f.c));await assert.rejects(()=>f.rpc('get_push_subscription',[device.id]),/unauthenticated/);
 await assert.rejects(()=>f.register(f.unverified),/unauthenticated/);
 await f.admin();await f.db.exec('set role anon');await assert.rejects(()=>f.rpc('get_notification_preferences'),/permission denied/);
});

test('the device limit permits enabled-device retries but also applies when re-enabling a revoked device',async t=>{
 const f=await privacyFixture(t),revoked=await f.register(f.b);
 await f.call(f.b,'revoke_push_subscription',[revoked.id]);
 const active=[];for(let i=0;i<10;i++)active.push(await f.register(f.b));
 const existing=active[0];await f.register(f.b,existing.id,existing.binding,existing.endpoint);
 await assert.rejects(()=>f.register(f.b),/push_device_limit/);
 await assert.rejects(()=>f.register(f.b,revoked.id,randomUUID(),revoked.endpoint),/push_device_limit/,'a revoked row must not bypass the enabled-device limit');
 await f.call(f.b,'revoke_push_subscription',[existing.id]);
 await f.register(f.b,revoked.id,randomUUID(),revoked.endpoint);
 assert.equal((await f.rows('select id from private.push_subscriptions where user_id=$1 and revoked_at is null',[f.b])).length,10);
});

test('transaction alerts reach direct participants on each enabled device, never unrelated members or the actor',async t=>{
 const f=await privacyFixture(t);
 await f.register(f.a);const b1=await f.register(f.b),b2=await f.register(f.b);await f.register(f.c);await f.register(f.outsider);
 const input=f.expenseInput({people:[f.b]});const expense=await f.save(f.a,input);
 const deliveries=await f.rows('select * from private.notification_outbox where entity_id=$1',[expense]);
 assert.deepEqual(deliveries.map(d=>d.subscription_id).sort(),[b1.id,b2.id].sort());
 assert.ok(deliveries.every(d=>d.user_id===f.b&&d.actor_id===f.a&&d.category==='expenses'));
 assert.equal(await f.save(f.a,input),expense);assert.equal((await f.rows('select id from private.notification_outbox where entity_id=$1',[expense])).length,2,'lost-response retry cannot enqueue twice');
 const state=await f.call(f.c,'get_household_state',[f.home,50]);const serialized=JSON.stringify(state);
 for(const value of [b1.endpoint,b2.endpoint,f.auth,f.publicKey])assert.ok(!serialized.includes(value),'household snapshots never disclose subscription secrets');
 const claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,2);
 for(const claim of claims){const data=await f.worker('get_notification_delivery',[claim.id,claim.lease_token]);assert.deepEqual(Object.keys(data).sort(),['attempts','auth','binding','category','endpoint','expires_at','id','p256dh','tone'].sort());assert.ok(!JSON.stringify(data).includes('Private fixture purchase'));assert.ok(!JSON.stringify(data).includes('Synthetic private note'));}
});

test('corrections union old and new participants once; failed or rolled-back changes create no alerts',async t=>{
 const f=await privacyFixture(t);for(const actor of [f.a,f.b,f.c,f.d])await f.register(actor);
 const original=await f.save(f.a,f.expenseInput({people:[f.b]}));
 const correction=f.expenseInput({people:[f.c,f.d],amount:1500});const replacement=await f.save(f.a,correction,original,1);
 const outbox=await f.rows('select n.user_id,a.action from private.notification_outbox n join public.activity_log a on a.id=n.activity_id where n.entity_id=$1',[replacement]);
 assert.deepEqual(outbox.map(n=>n.user_id).sort(),[f.b,f.c,f.d].sort());assert.ok(outbox.every(n=>n.action==='expense_corrected'));
 await f.save(f.a,correction,original,1);assert.equal((await f.rows('select id from private.notification_outbox where entity_id=$1',[replacement])).length,3);
 const before=(await f.rows('select id from private.notification_outbox')).length;
 await assert.rejects(()=>f.save(f.a,f.expenseInput({people:[f.outsider]})),/invalid_split/);
 await f.as(f.a);await f.db.exec('begin');
 const rolledBack=await f.rpc('save_expense',[JSON.stringify(f.expenseInput({people:[f.b]})),null,null,'',null]);
 await f.db.exec('rollback');
 assert.equal((await f.rows('select id from public.expenses where id=$1',[rolledBack])).length,0);
 assert.equal((await f.rows('select id from private.notification_outbox')).length,before,'outbox follows commit, never attempted mutations');
});

test('new subscriptions receive future updates only, and category opt-out is checked again before delivery',async t=>{
 const f=await privacyFixture(t);await f.save(f.a,f.expenseInput({people:[f.b]}));const device=await f.register(f.b);
 assert.equal((await f.rows('select id from private.notification_outbox')).length,0,'enabling does not replay historical activity');
 await f.call(f.b,'set_notification_preferences',[false,true,true,'friendly']);
 const expense=await f.save(f.a,f.expenseInput({people:[f.b]}));assert.equal((await f.rows('select id from private.notification_outbox')).length,0);
 const refund=await f.call(f.a,'refund_expense',[f.home,expense,100,'Synthetic refund',randomUUID()]);
 let claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);
 await f.call(f.b,'set_notification_preferences',[false,false,true,'brief']);
 assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null,'queued refund respects a later opt-out');
 assert.equal((await f.rows('select status from private.notification_outbox where entity_id=$1',[refund]))[0].status,'skipped');
 await f.call(f.b,'set_notification_preferences',[true,true,true,'friendly']);
 await f.save(f.a,f.expenseInput({people:[f.b]}));claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);
 await f.register(f.b,device.id,randomUUID(),device.endpoint);
 assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null,'re-enabled binding cannot inherit old queued deliveries');
 await f.save(f.a,f.expenseInput({people:[f.b]}));claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);
 await f.call(f.b,'revoke_push_subscription',[device.id]);assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null);
});

test('trip isolation and membership revocation gate queued delivery and notification navigation',async t=>{
 const f=await privacyFixture(t);for(const actor of [f.a,f.b,f.c])await f.register(actor);
 const expense=await f.save(f.a,f.expenseInput({group:f.trip,people:[f.b]}));
 const outbox=await f.rows('select * from private.notification_outbox where entity_id=$1',[expense]);assert.equal(outbox.length,1);assert.equal(outbox[0].user_id,f.b);
 assert.deepEqual(await f.call(f.b,'resolve_notification',[outbox[0].id]),{screen:'expenses',household:f.trip});
 await assert.rejects(()=>f.call(f.c,'resolve_notification',[outbox[0].id]),/notification_unavailable/);
 await f.call(f.a,'group_action',[f.home,'remove_member',f.b,'',randomUUID()]);
 await f.admin();await f.db.query("update public.group_members set status='active' where group_id=$1 and user_id=$2",[f.trip,f.b]);
 const claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);
 assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null,'orphan active trip membership cannot bypass revoked parent membership');
 await assert.rejects(()=>f.call(f.b,'resolve_notification',[outbox[0].id]),/notification_unavailable/);
});

test('session expiry, logout and device revocation prevent queued pushes without disabling another device',async t=>{
 const f=await privacyFixture(t),first=await f.register(f.b),second=await f.register(f.b);
 await f.save(f.a,f.expenseInput({people:[f.b]}));await f.call(f.b,'revoke_push_subscription',[first.id]);
 let claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);assert.equal((await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token])).endpoint,second.endpoint);
 await f.admin();await f.db.query('delete from auth.sessions where id=$1',[f.sessions.get(f.b)]);
 assert.equal(await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token]),null,'server-side logout invalidates pending device delivery');
 await f.admin();await f.db.query("insert into auth.sessions(id,user_id,not_after) values($1,$2,now()-interval '1 second')",[f.sessions.get(f.b),f.b]);
 await assert.rejects(()=>f.call(f.b,'get_push_subscription',[second.id]),/unauthenticated/);
 await f.save(f.a,f.expenseInput({people:[f.b]}));claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,0,'expired sessions are excluded before enqueue');
});

test('repayment events target the counterparty and worker leases bound retries and stale acknowledgments',async t=>{
 const f=await privacyFixture(t);const recipient=await f.register(f.a);await f.register(f.b);await f.register(f.c);
 const payment=await f.call(f.b,'record_repayment',[f.home,f.a,'sent',500,'2026-10-11','Synthetic transfer',false,randomUUID()]);
 const records=await f.rows('select * from private.notification_outbox where entity_id=$1',[payment]);assert.equal(records.length,1);assert.equal(records[0].user_id,f.a);assert.equal(records[0].category,'repayments');
 let claims=await f.worker('claim_notification_deliveries',[20]);const first=claims[0];assert.equal(claims.length,1);
 assert.equal(await f.worker('get_notification_delivery',[first.id,randomUUID()]),null);assert.equal(await f.worker('finish_notification_delivery',[first.id,randomUUID(),'sent',201,60]),false);
 assert.equal(await f.worker('finish_notification_delivery',[first.id,first.lease_token,'retry',503,60]),true);
 assert.equal((await f.worker('claim_notification_deliveries',[20])).length,0,'backoff prevents immediate retry');
 await f.admin();await f.db.query("update private.notification_outbox set available_at=now()-interval '1 second' where id=$1",[first.id]);
 claims=await f.worker('claim_notification_deliveries',[20]);assert.equal(claims.length,1);assert.notEqual(claims[0].lease_token,first.lease_token);
 assert.equal(await f.worker('finish_notification_delivery',[first.id,first.lease_token,'sent',201,60]),false,'stale worker cannot acknowledge a newer lease');
 assert.equal((await f.worker('get_notification_delivery',[claims[0].id,claims[0].lease_token])).attempts,2);
 await f.worker('finish_notification_delivery',[claims[0].id,claims[0].lease_token,'gone',410,60]);
 assert.equal((await f.call(f.a,'get_push_subscription',[recipient.id])).enabled,false,'permanent push rejection disables that endpoint');
 assert.equal((await f.rows('select status from private.notification_outbox where id=$1',[first.id]))[0].status,'dead');
});

test('pending repayment transitions and refunds notify only their counterparties; unrelated activity stays quiet',async t=>{
 const f=await privacyFixture(t);for(const actor of [f.a,f.b,f.c])await f.register(actor);
 await f.call(f.a,'set_payment_preferences',[true]);
 const pay=()=>f.call<string>(f.b,'record_repayment',[f.home,f.a,'sent',500,'2026-10-11','Synthetic transfer',true,randomUUID()]);
 const action=(actor:string,payment:string,kind:string,version:number)=>f.call(actor,'payment_action',[f.home,payment,kind,version,kind==='reverse'?'Synthetic correction':'',randomUUID()]);
 const payment=await pay();await action(f.a,payment,'confirm',1);await action(f.a,payment,'reverse',2);
 const rejected=await pay();await f.call(f.a,'payment_action',[f.home,rejected,'reject',1,'Synthetic rejection',randomUUID()]);
 const cancelled=await pay();await action(f.b,cancelled,'cancel',1);
 const received=await f.call(f.a,'record_repayment',[f.home,f.b,'received',600,'2026-10-11','Synthetic received transfer',true,randomUUID()]);
 const rows=await f.rows('select n.entity_id,n.user_id,a.action from private.notification_outbox n join public.activity_log a on a.id=n.activity_id order by a.occurred_at,a.id');
 const events=(entity:string)=>rows.filter(r=>r.entity_id===entity).map(r=>[r.action,r.user_id]).sort();
 assert.deepEqual(events(payment),[['payment_confirmed',f.b],['payment_recorded',f.a],['payment_reversed',f.b]].sort());
 assert.deepEqual(events(rejected),[['payment_recorded',f.a],['payment_rejected',f.b]].sort());
 assert.deepEqual(events(cancelled),[['payment_cancelled',f.a],['payment_recorded',f.a]].sort());
 assert.deepEqual(events(received),[['payment_received',f.b]]);
 const expense=await f.save(f.a,f.expenseInput()),refund=await f.call(f.a,'refund_expense',[f.home,expense,100,'Synthetic refund',randomUUID()]);
 await f.call(f.a,'void_refund',[f.home,refund,'Synthetic correction',randomUUID()]);
 const refunds=await f.rows('select n.user_id,a.action from private.notification_outbox n join public.activity_log a on a.id=n.activity_id where n.entity_id=$1',[refund]);
 assert.deepEqual(refunds.map(r=>[r.action,r.user_id]).sort(),[['refund_recorded',f.b],['refund_voided',f.b]].sort());
 const count=(await f.rows('select id from private.notification_outbox')).length;
 await f.call(f.b,'update_profile',['Blake Example']);await f.call(f.a,'add_shopping_item',[f.home,'Milk',1,'bottle','',false,randomUUID()]);
 assert.equal((await f.rows('select id from private.notification_outbox')).length,count,'name and shopping changes are not financial alerts');
});

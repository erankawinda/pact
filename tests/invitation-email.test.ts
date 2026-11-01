import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {privacyFixture,type PrivacyFixture} from './privacyFixture';

const config=['Pact <invites@example.test>','https://pact.example.test','invitation-v1'];
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
const create=(f:PrivacyFixture,email='guest@example.test',actor=f.a,group=f.trip)=>f.call<string>(actor,'create_invitation',[group,email]);
const begin=(f:PrivacyFixture,token:string,actor=f.a,group=f.trip,settings=config)=>f.worker('begin_invitation_email',[actor,group,hash(token),...settings]);
const finish=(f:PrivacyFixture,d:any,status:string,provider:string|null=null,error:string|null=null)=>f.worker('finish_invitation_email',[d.id,d.lease_id,status,provider,error]);
const status=(f:PrivacyFixture,actor=f.a,group=f.trip,token?:string)=>f.call<any[]>(actor,'get_invitation_email_status',[group,token?hash(token):null]);
async function elapseLease(f:PrivacyFixture,id:string){await f.admin();await f.db.query("update private.invitation_email_deliveries set last_attempt_at=clock_timestamp()-interval '61 seconds',lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[id]);}

test('invitation email records contain no recoverable token and expose only organizer delivery status',async t=>{
 const f=await privacyFixture(t),token=await create(f);
 const before=await status(f);assert.equal(before.length,1);assert.equal(before[0].status,'not_sent');assert.equal(before[0].intended_email,'guest@example.test');
 const delivery=await begin(f,token);assert.equal(delivery.claimed,true);assert.equal(delivery.status,'sending');assert.equal(delivery.can_retry,false);assert.equal(delivery.attempts,1);
 assert.equal(delivery.recipient,'guest@example.test');assert.equal(delivery.group_name,'Weekend');assert.equal(delivery.group_kind,'trip');assert.equal(delivery.inviter_name,'Alex');
 assert.equal(delivery.sender,config[0]);assert.equal(delivery.origin,config[1]);assert.equal(delivery.template,config[2]);
 assert.match(delivery.config_digest,/^[a-f0-9]{64}$/);assert.equal(new Date(delivery.retry_until).getTime()-new Date(delivery.last_attempt_at).getTime(),23*3600*1000);
 const rows=await f.rows('select row_to_json(d)::text as serialized from private.invitation_email_deliveries d');
 assert.equal(rows[0].serialized.includes(token),false);assert.equal(rows[0].serialized.includes(hash(token)),false);
 const safe=(await status(f))[0];
 for(const key of ['id','provider_id','lease_id','recipient','sender','origin','config_digest','token','token_hash'])assert.equal(key in safe,false,key);
 await assert.rejects(()=>status(f,f.b),/forbidden/);await assert.rejects(()=>status(f,f.outsider),/forbidden/);
 await f.as(f.a);
 for(const name of ['begin_invitation_email','finish_invitation_email']){
  const args=name==='begin_invitation_email'?[f.a,f.trip,hash(token),...config]:[delivery.id,delivery.lease_id,'sent',randomUUID(),null];
  await assert.rejects(()=>f.rpc(name,args),/permission denied/);
 }
 await assert.rejects(()=>f.db.query('select * from private.invitation_email_deliveries'),/permission denied/);
 await f.admin();await f.db.exec('set role anon');await assert.rejects(()=>f.rpc('get_invitation_email_status',[f.trip]),/permission denied/);
 await f.service();await assert.rejects(()=>f.db.query('update private.invitation_email_deliveries set attempts=1'),/permission denied/);
});

test('email service denies unverified, banned, non-Google and non-organizer actors without creating delivery state',async t=>{
 const f=await privacyFixture(t),token=await create(f);
 for(const actor of [f.b,f.outsider])await assert.rejects(()=>begin(f,token,actor),/invitation_email_forbidden/);
 await assert.rejects(()=>begin(f,token,f.unverified),/invitation_email_unauthenticated/);
 await f.admin();await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[f.a]);
 await assert.rejects(()=>begin(f,token),/invitation_email_unauthenticated/);
 await f.admin();await f.db.query("update auth.users set banned_until=null,raw_app_meta_data='{}',raw_user_meta_data='{\"providers\":[\"google\"]}' where id=$1",[f.a]);
 await assert.rejects(()=>begin(f,token),/invitation_email_unauthenticated/,'user metadata cannot grant Google identity');
 assert.equal((await f.rows('select id from private.invitation_email_deliveries')).length,0);
});

test('email sending validates exact invitation scope, current access and existing acceptance rules',async t=>{
 const f=await privacyFixture(t);let token=await create(f,'person4@example.test');
 await assert.rejects(()=>begin(f,token,f.a,f.home),/invitation_email_invalid_invitation/);
 await assert.rejects(()=>begin(f,'f'.repeat(64)),/invitation_email_invalid_invitation/);
 await f.call(f.outsider,'accept_invitation',[token]);await assert.rejects(()=>begin(f,token),/invitation_email_invalid_invitation/);
 token=await create(f);const old=token;token=await create(f);await assert.rejects(()=>begin(f,old),/invitation_email_invalid_invitation/);
 assert.deepEqual(await status(f,f.a,f.trip,old),[],'a replaced token cannot reconcile against a later invitation to the same email');
 await f.admin();await f.db.query("update public.invitations set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1",[hash(token)]);
 await assert.rejects(()=>begin(f,token),/invitation_email_invalid_invitation/);
 token=await create(f);await f.call(f.a,'group_action',[f.trip,'make_organiser',f.b,'',randomUUID()]);
 const fromOther=await create(f,'another@example.test',f.b);
 await f.admin();await f.db.query("update public.group_members set role='member' where group_id=$1 and user_id=$2",[f.trip,f.b]);
 await assert.rejects(()=>begin(f,fromOther),/invitation_email_invalid_invitation/,'even another organizer cannot send a demoted creator invitation');
 await f.call(f.a,'group_action',[f.trip,'archive',null,'',randomUUID()]);
 await assert.rejects(()=>begin(f,token),/invitation_email_forbidden/);
 assert.equal((await f.rows('select id from private.invitation_email_deliveries')).length,0);
});

test('one lease wins, retries freeze payload metadata, and stale results cannot overwrite newer attempts',async t=>{
 const f=await privacyFixture(t),token=await create(f),first=await begin(f,token);
 const duplicate=await begin(f,token);assert.equal(duplicate.claimed,false);assert.equal(duplicate.id,first.id);assert.equal(duplicate.lease_id,null);assert.equal(duplicate.attempts,1);
 await finish(f,first,'unknown',null,'provider_timeout');
 assert.equal((await begin(f,token)).claimed,false,'unknown outcomes respect cooldown');
 await elapseLease(f,first.id);
 await f.admin();await f.db.query("update public.groups set name='Changed trip name' where id=$1",[f.trip]);await f.db.query("update public.profiles set display_name='Changed name' where id=$1",[f.a]);
 const retry=await begin(f,token,f.a,f.trip,['New sender <next@example.test>','https://new.example.test','invitation-v1']);
 assert.equal(retry.claimed,true);assert.equal(retry.id,first.id);assert.notEqual(retry.lease_id,first.lease_id);assert.equal(retry.attempts,2);
 for(const key of ['sender','origin','template','config_digest','group_name','inviter_name','recipient','expires_at','retry_until'])assert.equal(retry[key],first[key],key);
 const stale=await finish(f,first,'sent',randomUUID());assert.equal(stale.status,'sending');
 const sent=await finish(f,retry,'sent',randomUUID());assert.equal(sent.status,'sent');assert.ok(sent.sent_at);assert.equal(sent.can_retry,false);
 await finish(f,retry,'unknown',null,'delivery_unconfirmed');assert.equal((await status(f))[0].status,'sent','late failure never regresses sent');
 assert.equal((await begin(f,token)).claimed,false,'provider-accepted message never resends');
 const saved=(await f.rows('select attempts,status from private.invitation_email_deliveries'))[0];assert.deepEqual(saved,{attempts:2,status:'sent'});
});

test('unknown outcomes stop after four attempts or 23 hours; definite failures are terminal',async t=>{
 const f=await privacyFixture(t),token=await create(f);let d=await begin(f,token);
 for(let attempt=1;attempt<=4;attempt++){
  assert.equal(d.attempts,attempt);await finish(f,d,'unknown',null,'provider_unavailable');await elapseLease(f,d.id);
  const next=await begin(f,token);assert.equal(next.claimed,attempt<4);d=next;
 }
 assert.equal((await status(f))[0].can_retry,false);
 const expiringToken=await create(f,'window@example.test'),expiring=await begin(f,expiringToken);
 await elapseLease(f,expiring.id);await f.admin();await f.db.query("update private.invitation_email_deliveries set first_attempt_at=clock_timestamp()-interval '23 hours 1 second' where id=$1",[expiring.id]);
 const expired=await begin(f,expiringToken);assert.equal(expired.status,'unknown');assert.equal(expired.claimed,false);assert.equal(expired.can_retry,false);
 const rejectedToken=await create(f,'rejected@example.test'),rejected=await begin(f,rejectedToken);
 await finish(f,rejected,'failed',null,'provider_rejected');await elapseLease(f,rejected.id);
 assert.equal((await begin(f,rejectedToken)).claimed,false);
 await assert.rejects(()=>finish(f,rejected,'sent',null),/invitation_email_invalid_request/);
 await assert.rejects(()=>finish(f,rejected,'failed',null,'a private provider response'),/invitation_email_invalid_request/);
});

test('recipient cooldown and hourly cap survive replacement links and different groups',async t=>{
 const f=await privacyFixture(t),email='shared-recipient@example.test';
 for(let i=0;i<3;i++){
  const group=i%2===0?f.trip:f.home,token=await create(f,email,f.a,group),d=await begin(f,token,f.a,group);
  const replacement=await create(f,email,f.a,group);
  await assert.rejects(()=>begin(f,replacement,f.a,group),/invitation_email_rate_limit/,'new token does not bypass recipient cooldown');
  await f.admin();await f.db.query("update private.invitation_email_deliveries set first_attempt_at=clock_timestamp()-interval '2 minutes' where id=$1",[d.id]);
 }
 const fourth=await create(f,email);await assert.rejects(()=>begin(f,fourth),/invitation_email_rate_limit/,'recipient cap spans groups and links');
 assert.equal((await f.rows('select count(*)::integer as n from private.invitation_email_deliveries'))[0].n,3);
});

test('actor hourly and group daily caps count all new deliveries, including completed failures',async t=>{
 const f=await privacyFixture(t);
 for(let i=0;i<20;i++){
  const token=await create(f,`rate${i}@example.test`),d=await begin(f,token);
  await finish(f,d,'failed',null,'provider_rejected');
 }
 await assert.rejects(async()=>begin(f,await create(f,'over-cap@example.test')),/invitation_email_rate_limit/);
 await f.call(f.a,'group_action',[f.trip,'make_organiser',f.b,'',randomUUID()]);
 // Fill a synthetic group history to isolate its aggregate cap from the
 // per-actor cap. Existing historical messages remain counted after failure.
 await f.admin();await f.db.exec(`
 with invites as (
  insert into public.invitations(group_id,intended_email,token_hash,expires_at,created_by,access_basis)
  select d.group_id,'history'||n||'@example.test',encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),
   clock_timestamp()+interval '7 days',d.actor_id,'direct'
  from (select * from private.invitation_email_deliveries limit 1) d cross join generate_series(1,80) n returning *
 )
 insert into private.invitation_email_deliveries(invitation_id,actor_id,group_id,recipient,group_name,group_kind,inviter_name,expires_at,sender,origin,template,config_digest,status,first_attempt_at,last_attempt_at,lease_id,lease_expires_at,error_code)
 select i.id,i.created_by,i.group_id,i.intended_email,d.group_name,d.group_kind,d.inviter_name,i.expires_at,d.sender,d.origin,d.template,d.config_digest,
 'failed',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',gen_random_uuid(),clock_timestamp()-interval '2 hours','provider_rejected'
 from invites i cross join (select * from private.invitation_email_deliveries limit 1) d;
 `);
 const token=await create(f,'group-cap@example.test',f.b);await assert.rejects(()=>begin(f,token,f.b),/invitation_email_rate_limit/);
 assert.equal((await f.rows('select count(*)::integer as n from private.invitation_email_deliveries'))[0].n,100);
});

test('email metadata is validated and revoked links cannot be retried or reported as a replacement',async t=>{
 const f=await privacyFixture(t),token=await create(f);
 for(const settings of [[config[0]+'\r\nBcc: outsider@example.test',config[1],config[2]],[config[0],'https://example.test/redirect',config[2]],[config[0],config[1],'unknown-template']])
  await assert.rejects(()=>begin(f,token,f.a,f.trip,settings),/invitation_email_invalid_request/);
 const d=await begin(f,token);await finish(f,d,'unknown',null,'provider_timeout');await elapseLease(f,d.id);
 const fresh=await create(f);await assert.rejects(()=>begin(f,token),/invitation_email_invalid_invitation/);
 assert.deepEqual(await status(f,f.a,f.trip,token),[]);assert.equal((await status(f,f.a,f.trip,fresh))[0].status,'not_sent');
 await assert.rejects(()=>f.call(f.a,'get_invitation_email_status',[f.trip,'not-a-digest']),/invitation_email_invalid_request/);
});

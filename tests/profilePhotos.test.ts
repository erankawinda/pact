import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import jpeg from 'jpeg-js';
import {privacyFixture,type PrivacyFixture} from './privacyFixture';
import {photoHandler,type PhotoServices} from '../supabase/functions/profile-photo/handler';
import {jpegDimensions,sanitizePhoto,readPhotoBody,MAX_PHOTO_BYTES} from '../supabase/functions/profile-photo/image';

const digest='a'.repeat(64);
function actions(f:PrivacyFixture){
 const photo=(user:string,action:string,request:string|null=null,version:string|null=null,hash:string|null=null,target:string|null=null)=>f.worker('profile_photo_action',[user,action,request,version,hash,target]);
 async function object(path:string,size=100,mimetype='image/jpeg'){await f.admin();await f.db.query("insert into storage.objects(bucket_id,name,metadata) values('profile-photos',$1,$2) on conflict(bucket_id,name) do update set metadata=excluded.metadata",[path,JSON.stringify({size,mimetype})]);}
 async function removeObject(path:string){await f.admin();await f.db.query("delete from storage.objects where bucket_id='profile-photos' and name=$1",[path]);}
 async function ready(user:string){const request=randomUUID(),reserved=await photo(user,'reserve',request,null,digest);await object(reserved.object_path);return photo(user,'complete',request,null,digest);}
 return {photo,object,removeObject,ready};
}

test('private photos require verified users and deny direct browser lifecycle or Storage access',async t=>{
 const f=await privacyFixture(t),{photo,ready}=actions(f),saved=await ready(f.a);
 await f.as(f.a);await assert.rejects(()=>f.rpc('profile_photo_action',[f.a,'status']),/permission denied/);
 for(const name of ['photo_slots','photo_requests'])await assert.rejects(()=>f.db.query(`select * from private.${name}`),/permission denied/);
 assert.equal((await f.db.query('select * from storage.objects')).rows.length,0,'even the owner must use the authenticated proxy');
 await assert.rejects(()=>f.db.query("insert into storage.objects(bucket_id,name) values('profile-photos',$1)",[`${f.a}/${randomUUID()}.jpg`]),/row-level security/);
 await f.admin();await f.db.exec('set role anon');await assert.rejects(()=>f.rpc('profile_photo_action',[f.a,'status']),/permission denied/);
 await assert.rejects(()=>photo(f.unverified,'status'),/photo_unauthenticated/);
 await assert.rejects(()=>photo(f.a,'status',null,null,null,f.b),/photo_forbidden/);
 await assert.rejects(()=>photo(f.a,'reserve',randomUUID(),null,digest,f.b),/photo_forbidden/);
 assert.equal((await photo(f.a,'status')).generation,saved.generation);
 const bucket=(await f.rows("select * from storage.buckets where id='profile-photos'"))[0];assert.equal(bucket.public,false);assert.equal(Number(bucket.file_size_limit),262144);assert.deepEqual(bucket.allowed_mime_types,['image/jpeg']);
});

test('photo visibility is limited to self and current shared members, including both trip parents',async t=>{
 const f=await privacyFixture(t),{photo,ready}=actions(f);await ready(f.b);await ready(f.outsider);
 assert.equal((await photo(f.a,'read',null,null,null,f.b)).status,'ready');
 assert.equal((await photo(f.outsider,'read')).status,'ready','a person without this household may view their own photo');
 await assert.rejects(()=>photo(f.outsider,'read',null,null,null,f.b),/photo_not_found/);
 await f.call(f.a,'group_action',[f.home,'remove_member',f.b,'',randomUUID()]);
 await f.admin();await f.db.query("update public.group_members set status='active' where group_id=$1 and user_id=$2",[f.trip,f.b]);
 const state=await f.call(f.a,'get_household_state',[f.home,50]);assert.ok(state.members.some((m:any)=>m.id===f.b&&m.status==='revoked'),'ledger names remain available');
 await assert.rejects(()=>photo(f.a,'read',null,null,null,f.b),/photo_not_found/,'a former member photo does not inherit historical name visibility');
 await assert.rejects(()=>photo(f.b,'read',null,null,null,f.a),/photo_not_found/,'orphan active trip membership grants no photo access');
 assert.equal((await photo(f.b,'read')).status,'ready','removal from a household does not delete the person’s own photo');
});

test('photo add/remove lifecycle requires verified storage and removal before replacement',async t=>{
 const f=await privacyFixture(t),{photo,object,removeObject}=actions(f);const request=randomUUID();
 const slot=await photo(f.a,'reserve',request,null,digest);assert.equal(slot.status,'uploading');assert.equal(slot.claimed,true);
 assert.equal((await photo(f.a,'reserve',request,null,digest)).claimed,false,'only the first upload worker owns the write');
 await assert.rejects(()=>photo(f.a,'complete',request,null,digest),/photo_storage_missing/);
 for(const [size,mime] of [[0,'image/jpeg'],[262145,'image/jpeg'],[100,'image/png']] as const){await object(slot.object_path,size,mime);await assert.rejects(()=>photo(f.a,'complete',request,null,digest),/photo_storage_missing/);}
 await object(slot.object_path);assert.equal((await photo(f.a,'complete',request,null,digest)).status,'ready');
 assert.equal((await photo(f.a,'reserve',request,null,digest)).status,'ready','retry after lost completion returns the saved photo');
 await assert.rejects(()=>photo(f.a,'reserve',randomUUID(),null,digest),/photo_exists/);
 const removal=randomUUID();assert.equal((await photo(f.a,'begin_delete',removal,request)).status,'deleting');
 await assert.rejects(()=>photo(f.a,'read'),/photo_not_found/,'deleting photos are hidden before their bytes are removed');
 await assert.rejects(()=>photo(f.a,'reserve',randomUUID(),null,digest),/photo_busy/);
 await assert.rejects(()=>photo(f.a,'complete_delete',removal,request),/photo_storage_remaining/);
 await removeObject(slot.object_path);assert.equal((await photo(f.a,'complete_delete',removal,request)).status,'empty');
 const replacement=randomUUID();assert.equal((await photo(f.a,'reserve',replacement,null,digest)).claimed,true);
 await photo(f.a,'complete_delete',removal,request);assert.equal((await photo(f.a,'status')).generation,replacement,'old delete retry cannot remove the new generation');
});

test('photo leases, request IDs and stale-device interleavings cannot overwrite or clean up a current photo',async t=>{
 const f=await privacyFixture(t),{photo,object,removeObject}=actions(f),request=randomUUID();
 const slot=await photo(f.a,'reserve',request,null,digest);
 await assert.rejects(()=>photo(f.a,'reserve',request,null,'b'.repeat(64)),/photo_request_conflict/);
 await assert.rejects(()=>photo(f.a,'reserve',randomUUID(),null,digest),/photo_busy/,'second device cannot create a competing slot');
 await assert.rejects(()=>photo(f.a,'cleanup_upload',null,request),/photo_stale_operation/);
 await assert.rejects(()=>photo(f.a,'begin_delete',randomUUID(),request),/photo_busy/);
 await object(slot.object_path);
 await f.admin();await f.db.query("update private.photo_slots set lease_expires_at=now()-interval '1 second' where user_id=$1",[f.a]);
 assert.equal((await photo(f.a,'reserve',randomUUID(),null,digest)).status,'cleanup');
 await assert.rejects(()=>photo(f.a,'complete',request,null,digest),/photo_stale_operation/);
 await assert.rejects(()=>photo(f.a,'cleanup_upload',null,request),/photo_storage_remaining/);
 await removeObject(slot.object_path);assert.equal((await photo(f.a,'cleanup_upload',null,request)).status,'empty');
 await assert.rejects(()=>photo(f.a,'reserve',request,null,digest),/photo_request_finished/,'expired request cannot be reused to restore an old photo');
 const replacement=randomUUID(),next=await photo(f.a,'reserve',replacement,null,digest);await object(next.object_path);await photo(f.a,'complete',replacement,null,digest);
 await assert.rejects(()=>photo(f.a,'cleanup_upload',null,request),/photo_stale_operation/);
 await assert.rejects(()=>photo(f.a,'begin_delete',randomUUID(),request),/photo_stale_operation/);
 assert.equal((await photo(f.a,'status')).generation,replacement);
});

function syntheticJpeg(){const pixels=Buffer.alloc(12*8*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=(i*3)%256;pixels[i+1]=80;pixels[i+2]=180;pixels[i+3]=255;}return new Uint8Array(jpeg.encode({width:12,height:8,data:pixels},80).data);}
function withPrivateMetadata(bytes:Uint8Array){const payload=Buffer.from('Exif\0\0SYNTHETIC GPS PRIVATE METADATA');const marker=Buffer.alloc(4);marker[0]=255;marker[1]=225;marker.writeUInt16BE(payload.length+2,2);return new Uint8Array(Buffer.concat([bytes.subarray(0,2),marker,payload,bytes.subarray(2)]));}

test('the photo server decodes pixels and strips metadata, rejecting fake or unbounded image bodies',async()=>{
 const original=withPrivateMetadata(syntheticJpeg()),clean=sanitizePhoto(original);assert.deepEqual(jpegDimensions(clean),{width:12,height:8});
 assert.equal(Buffer.from(clean).includes(Buffer.from('SYNTHETIC GPS PRIVATE METADATA')),false);
 assert.ok(clean.length<=MAX_PHOTO_BYTES);assert.equal(jpeg.decode(clean).width,12);
 for(const bytes of [new Uint8Array(),Buffer.from('<svg/>'),original.subarray(0,original.length-2),Buffer.alloc(MAX_PHOTO_BYTES+1)])assert.throws(()=>sanitizePhoto(bytes));
 const huge=Buffer.from(original);const sof=huge.indexOf(Buffer.from([255,192]));assert.ok(sof>0);huge.writeUInt16BE(513,sof+7);assert.throws(()=>sanitizePhoto(huge),/512/);
 const progressive=Buffer.from(original);progressive[sof+1]=194;assert.throws(()=>sanitizePhoto(progressive));
 await assert.rejects(()=>readPhotoBody(new Request('https://example.test',{method:'POST',body:original,headers:{'Content-Type':'image/png'}})),/JPEG/);
 await assert.rejects(()=>readPhotoBody(new Request('https://example.test',{method:'POST',body:original,headers:{'Content-Type':'image/jpeg','Content-Length':String(MAX_PHOTO_BYTES+1)}})),/256/);
 const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_PHOTO_BYTES));controller.enqueue(new Uint8Array(1));controller.close();}});
 await assert.rejects(()=>readPhotoBody(new Request('https://example.test',{method:'POST',body:stream,duplex:'half',headers:{'Content-Type':'image/jpeg'}} as RequestInit)),/256/,'streamed body limit is enforced without trusting Content-Length');
});

test('authenticated photo proxy sanitizes output, keeps paths private and safely retries partial failures',async t=>{
 const f=await privacyFixture(t),{photo,object,removeObject}=actions(f),objects=new Map<string,Uint8Array>();let failUpload=false,failRemove=false,revokedDuringDownload=false,uploads=0;
 const services:PhotoServices={
  authenticate:async token=>{if(!f.users.some(user=>user===token))throw new Error('photo_unauthenticated: invalid token');return token;},
  action:async(user,action,args={})=>photo(user,action,args.request??null,args.version??null,args.digest??null,args.target??null),
  upload:async(path,bytes)=>{uploads++;if(failUpload)throw new Error('Secret internal backend failure');objects.set(path,bytes);await object(path,bytes.length);},
  remove:async path=>{if(failRemove)throw new Error('Secret internal backend failure');objects.delete(path);await removeObject(path);},
  download:async path=>{if(revokedDuringDownload){await f.call(f.a,'group_action',[f.home,'remove_member',f.b,'',randomUUID()]);}return new Blob([new Uint8Array(objects.get(path)!)],{type:'image/jpeg'});},
 };
 const handle=photoHandler(services);
 const request=(method:string,actor:string=f.a,id?:string,version?:string,body?:Uint8Array,target?:string)=>new Request(`https://example.test/profile-photo${target?`?user_id=${target}`:''}`,{method,headers:{Authorization:`Bearer ${actor}`,...(id?{'X-Request-Id':id}:{}),...(version?{'X-Photo-Version':version}:{}),...(body?{'Content-Type':'image/jpeg'}:{})},body:body?new Uint8Array(body):undefined});
 let response=await handle(new Request('https://example.test/profile-photo'));assert.equal(response.status,401);assert.match(response.headers.get('Cache-Control')??'',/no-store/);
 const upload=randomUUID(),source=withPrivateMetadata(syntheticJpeg());response=await handle(request('POST',f.a,upload,undefined,source));assert.equal(response.status,201);const status=await response.json();assert.equal(status.status,'ready');assert.equal('object_path' in status,false);assert.equal('source_sha256' in status,false);
 assert.equal(Buffer.from([...objects.values()][0]).includes(Buffer.from('SYNTHETIC GPS PRIVATE METADATA')),false);
 response=await handle(request('POST',f.a,upload,undefined,source));assert.equal(response.status,200);assert.equal(uploads,1,'same completed request is not uploaded again');
 response=await handle(request('GET',f.b,undefined,undefined,undefined,f.a));assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/jpeg');assert.match(response.headers.get('Cache-Control')??'',/no-store/);assert.equal(response.headers.get('Vary'),'Authorization');
 response=await handle(request('GET',f.outsider,undefined,undefined,undefined,f.a));assert.equal(response.status,404);
 revokedDuringDownload=true;response=await handle(request('GET',f.b,undefined,undefined,undefined,f.a));assert.equal(response.status,404,'access rechecked after download before returning bytes');revokedDuringDownload=false;
 const removal=randomUUID();failRemove=true;response=await handle(request('DELETE',f.a,removal,status.version));assert.equal(response.status,503);assert.ok(!(await response.text()).includes('Secret internal'));assert.equal((await photo(f.a,'status')).status,'deleting');
 response=await handle(request('POST',f.a,randomUUID(),undefined,source));assert.equal(response.status,409,'failed removal does not enable replacement');
 failRemove=false;response=await handle(request('DELETE',f.a,removal,status.version));assert.equal(response.status,200);assert.equal(objects.size,0);
 failUpload=true;const interrupted=randomUUID();response=await handle(request('POST',f.a,interrupted,undefined,source));assert.equal(response.status,503);assert.equal((await photo(f.a,'status')).status,'uploading','uncertain upload keeps a fenced operation');
 failUpload=false;response=await handle(request('POST',f.a,interrupted,undefined,source));assert.equal(response.status,202,'retry checks existing lease without a second writer');
});

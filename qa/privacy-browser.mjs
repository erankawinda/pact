// Synthetic HTTP boundary checks for the opt-in photo interface. No hosted
// account, database, Storage object or original personal photo is accessed.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import jpeg from 'jpeg-js';
const host='http://127.0.0.1:4174',fixtureOrigin='https://pact-photo-fixture.supabase.co';
const server=await createServer({envDir:false,define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(fixtureOrigin),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_fixture_only'),'import.meta.env.VITE_PROFILE_PHOTOS_ENABLED':'"true"','import.meta.env.VITE_NOTIFICATIONS_ENABLED':'"false"','import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY':'""'},server:{host:'127.0.0.1',port:4174,strictPort:true}});
await server.listen();const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const out='qa/artifacts/privacy';mkdirSync(out,{recursive:true});const results=[],nameFilter=process.argv.slice(2).join(' ');
const axe=readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')),'utf8');
function syntheticPhonePhoto(){
 const width=60,height=40,data=Buffer.alloc(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;data[i]=y<20?240:10;data[i+1]=10;data[i+2]=y<20?10:240;data[i+3]=255;}
 const encoded=jpeg.encode({width,height,data},95).data;
 // EXIF orientation 3 flips top/bottom; the comment is deliberately private.
 const exif=Buffer.from([69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,3,0,0,0,0,0,0,0]);
 const segment=(marker,payload)=>{const head=Buffer.from([255,marker,0,0]);head.writeUInt16BE(payload.length+2,2);return Buffer.concat([head,payload]);};
 return Buffer.concat([encoded.subarray(0,2),segment(225,exif),segment(254,Buffer.from('SYNTHETIC PRIVATE LOCATION')),encoded.subarray(2)]);
}
const source=syntheticPhonePhoto();
async function fixture(initial='empty',{statusFailure=false,displayName='Alex'}={}){
 const user={id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'alex@example.test',email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{provider:'google',providers:['google']},user_metadata:{full_name:'Alex'},created_at:'2026-10-01T00:00:00Z'};
 const session={access_token:[{alg:'HS256',typ:'JWT'},{sub:user.id,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'fixture'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.'),refresh_token:'local-only',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user};
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light',reducedMotion:'reduce'});
 await context.addInitScript(session=>localStorage.setItem('sb-pact-photo-fixture-auth-token',JSON.stringify(session)),session);
 const state={status:initial,version:initial==='ready'?randomUUID():null,bytes:initial==='ready'?source:null,uploads:[],deletes:[],errors:[],unexpected:[],fail:statusFailure?'status':'',profileWrites:0,photoStatusReads:0};
 await context.routeWebSocket(/^wss:/,ws=>ws.close());
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin===host)return route.continue();
  const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data),headers:{'Access-Control-Allow-Origin':host,'Cache-Control':'private, no-store'}});
  if(url.origin!==fixtureOrigin){state.unexpected.push(url.href);return route.abort();}
  if(req.method()==='OPTIONS')return json({});
  if(url.pathname==='/auth/v1/user')return json(user);
  if(url.pathname==='/rest/v1/groups')return json([]);
  if(url.pathname==='/rest/v1/profiles')return json({display_name:displayName});
  if(url.pathname==='/rest/v1/rpc/get_payment_preferences')return json(false);
  if(url.pathname==='/rest/v1/rpc/update_profile'){state.profileWrites++;return json('Alex');}
  if(url.pathname==='/functions/v1/profile-photo'){
   assert.match(req.headers().authorization,/^Bearer /);assert.equal(req.headers().apikey,'sb_publishable_fixture_only');
   if(req.method()==='GET'&&url.searchParams.get('status')==='1'){
    state.photoStatusReads++;
    if(state.fail==='status'){state.fail='';return json({message:'Your photo could not be loaded. Please try again.'},503);}
    return json({status:state.status,version:state.version,operation_id:state.version});
   }
   if(req.method()==='GET')return state.status==='ready'?route.fulfill({status:200,contentType:'image/jpeg',body:state.bytes,headers:{'Cache-Control':'private, no-store'}}):json({message:'Photo is unavailable.'},404);
   if(req.method()==='POST'){
    const bytes=req.postDataBuffer(),id=req.headers()['x-request-id'];state.uploads.push({bytes,id});assert.equal(req.headers()['content-type'],'image/jpeg');
    if(state.fail==='save'){state.fail='';return json({message:'Photo save could not be confirmed.'},503);}
    state.status='ready';state.version=id;state.bytes=bytes;
    if(state.fail==='lost-save'){state.fail='';return route.abort('failed');}
    return json({status:'ready',version:state.version},201);
   }
   if(req.method()==='DELETE'){
    const id=req.headers()['x-request-id'],version=req.headers()['x-photo-version'];state.deletes.push({id,version});
    if(state.fail==='stale-delete'){state.fail='';state.version=randomUUID();state.status='ready';return json({message:'The photo changed. Refresh before trying again.'},409);}
    if(state.fail==='delete'){state.fail='';state.status='deleting';return json({message:'Photo removal is unfinished. Retry removing it.'},503);}
    assert.equal(version,state.version,'request must delete exactly the displayed generation');state.status='empty';state.version=null;state.bytes=null;return json({status:'empty'});
   }
  }
  state.unexpected.push(req.method()+' '+url.pathname);return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>state.errors.push(String(e)));page.on('console',message=>{if(/Encountered two children with the same key|Each child in a list should have a unique/.test(message.text()))state.errors.push(message.text());});await page.goto(host);
 await page.getByRole('button',{name:'Create a household',exact:true}).waitFor();await page.getByRole('button',{name:'Account',exact:true}).click();
 await page.locator('#profile-photo-heading').waitFor();
 if(statusFailure)await page.getByRole('alert').waitFor();else await page.getByRole('button',{name:initial==='ready'?'Remove photo':'Choose a photo',exact:true}).waitFor();
 return {page,state,close:async()=>{assert.deepEqual(state.errors,[]);assert.deepEqual(state.unexpected,[]);await context.close();}};
}
async function choose(page){const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Choose a photo',exact:true}).click()]);await chooser.setFiles({name:'phone-photo.jpg',mimeType:'image/jpeg',buffer:source});await page.getByRole('button',{name:'Save photo',exact:true}).waitFor();}
async function reachable(locator,label){
 await locator.scrollIntoViewIfNeeded();
 const result=await locator.evaluate(element=>{const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return {visible:rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1,uncovered:!!hit&&element.contains(hit)};});
 assert.ok(result.visible&&result.uncovered,`${label}: ${JSON.stringify(result)}`);
}
async function accessibility(page,label){await page.addScriptTag({content:axe});const result=await page.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],label);}
async function capture(page,label){const top=()=>page.evaluate(async()=>{window.scrollTo({top:0,behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await top();await page.screenshot({path:`${out}/${label}.png`,fullPage:true,animations:'disabled'});await top();await page.screenshot({path:`${out}/${label}-viewport.png`,fullPage:false,animations:'disabled'});}
async function test(name,run){if(nameFilter&&!name.includes(nameFilter))return;try{await run();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',error:String(e)});throw e;}finally{writeFileSync(`${out}/${nameFilter?'results-focused':'results'}.json`,JSON.stringify(results,null,2));}}
try{
 await test('account layout keeps profile, photo and settings reachable at phone and tablet widths in both themes',async()=>{
  const f=await fixture('empty',{displayName:'Alex Morgan'});
  for(const scheme of ['light','dark']){
   await f.page.emulateMedia({colorScheme:scheme});
   for(const width of [320,390,768]){
    await f.page.setViewportSize({width,height:844});
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${scheme} account overflows at ${width}`);
    for(const name of ['Choose a photo','Switch Google account','Sign out'])await reachable(f.page.getByRole('button',{name,exact:true}),`${scheme} ${width}: ${name}`);
    await reachable(f.page.getByLabel('Display name',{exact:true}),`${scheme} ${width}: display name`);
    await accessibility(f.page,`${scheme} account ${width}`);
    if(width===390)await capture(f.page,`account-redesign-${scheme}`);
    if(width===320)await capture(f.page,`account-redesign-${scheme}-320`);
   }
  }
  assert.equal(f.state.uploads.length+f.state.deletes.length+f.state.profileWrites,0);await f.close();
 });
 await test('photo status failures show a recoverable error and never unlock an unknown photo slot',async()=>{
  const f=await fixture('empty',{statusFailure:true});
  await f.page.getByRole('alert').getByText('Your photo could not be loaded. Please try again.',{exact:true}).waitFor();
  assert.equal(await f.page.getByRole('button',{name:'Choose a photo',exact:true}).count(),0);
  assert.equal(await f.page.getByRole('button',{name:'Remove photo',exact:true}).count(),0);
  await capture(f.page,'photo-load-error');
  await f.page.getByRole('button',{name:'Check photo status',exact:true}).click();
  await f.page.getByRole('button',{name:'Choose a photo',exact:true}).waitFor();
  assert.equal(await f.page.getByRole('alert').count(),0);assert.equal(f.state.photoStatusReads,2);
  await choose(f.page);assert.equal(f.state.uploads.length,0,'recovered status allows a local preview, not an automatic upload');await f.close();
 });
 await test('phone preparation honors orientation, crops locally and removes metadata before any upload',async()=>{
  const f=await fixture();const result=await f.page.evaluate(async b64=>{
   const {prepareProfilePhoto}=await import('/src/photoProcessing.ts');
   const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const blob=await prepareProfilePhoto(new File([bytes],'renamed.dat',{type:'application/octet-stream'}));
   const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
   const output=new Uint8Array(await blob.arrayBuffer());const answer={width:bitmap.width,height:bitmap.height,type:blob.type,size:blob.size,top:Array.from(ctx.getImageData(20,8,1,1).data),bottom:Array.from(ctx.getImageData(20,32,1,1).data),hasExif:new TextDecoder().decode(output).includes('Exif'),hasPrivate:new TextDecoder().decode(output).includes('SYNTHETIC PRIVATE LOCATION')};bitmap.close();return answer;
  },source.toString('base64'));
  assert.equal(result.width,40);assert.equal(result.height,40);assert.equal(result.type,'image/jpeg');assert.ok(result.size<=262144);assert.ok(result.top[2]>result.top[0]+150&&result.bottom[0]>result.bottom[2]+150,'EXIF orientation is applied before crop');assert.equal(result.hasExif,false);assert.equal(result.hasPrivate,false);
  const crop=await f.page.evaluate(async()=>{
   const {prepareProfilePhoto}=await import('/src/photoProcessing.ts');const source=document.createElement('canvas');source.width=1200;source.height=800;const ctx=source.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,1200,800);ctx.fillStyle='#00ff00';ctx.fillRect(200,0,800,800);const input=await new Promise(resolve=>source.toBlob(resolve,'image/png'));const photo=await prepareProfilePhoto(new File([input],'phone.png'));const bitmap=await createImageBitmap(photo);const result=document.createElement('canvas');result.width=result.height=512;const out=result.getContext('2d');out.drawImage(bitmap,0,0);const pixels=[out.getImageData(5,256,1,1).data[1],out.getImageData(506,256,1,1).data[1]];return {width:bitmap.width,height:bitmap.height,size:photo.size,pixels};
  });assert.equal(crop.width,512);assert.equal(crop.height,512);assert.ok(crop.size<=262144&&crop.pixels.every(v=>v>230));assert.equal(f.state.uploads.length,0);await f.close();
 });
 await test('photo selection previews locally; save sends only processed JPEG and retries reuse the request',async()=>{
  const f=await fixture();await choose(f.page);assert.equal(f.state.uploads.length,0);assert.equal(f.state.profileWrites,0);await f.page.getByRole('img',{name:'Your new profile photo preview',exact:true}).waitFor();
  for(const scheme of ['light','dark']){await f.page.emulateMedia({colorScheme:scheme});for(const width of [320,390]){await f.page.setViewportSize({width,height:844});assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}await f.page.addScriptTag({content:axe});const violations=await f.page.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));assert.deepEqual(violations.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);}
  f.state.fail='save';await f.page.getByRole('button',{name:'Save photo',exact:true}).click();await f.page.getByRole('alert').waitFor();assert.equal(f.state.uploads.length,1);await f.page.getByRole('button',{name:'Save photo',exact:true}).click();await f.page.getByRole('button',{name:'Remove photo',exact:true}).waitFor();assert.equal(f.state.uploads.length,2);assert.equal(f.state.uploads[0].id,f.state.uploads[1].id);assert.deepEqual(f.state.uploads[0].bytes,f.state.uploads[1].bytes);
  const uploaded=f.state.uploads[0].bytes;assert.ok(uploaded.length<=262144);assert.ok(!uploaded.equals(source));assert.equal(uploaded.includes(Buffer.from('SYNTHETIC PRIVATE LOCATION')),false);assert.equal(jpeg.decode(uploaded).width,40);assert.equal(await f.page.getByRole('button',{name:'Choose a photo',exact:true}).count(),0);await f.page.screenshot({path:`${out}/photo-ready.png`,fullPage:true});await f.close();
 });
 await test('lost save response resolves status without uploading again, and failed deletion blocks a new photo',async()=>{
  const f=await fixture();await choose(f.page);f.state.fail='lost-save';await f.page.getByRole('button',{name:'Save photo',exact:true}).click();await f.page.getByRole('button',{name:'Remove photo',exact:true}).waitFor();assert.equal(f.state.uploads.length,1);assert.equal(await f.page.getByRole('button',{name:'Save photo',exact:true}).count(),0);
  await f.page.getByRole('button',{name:'Remove photo',exact:true}).click();assert.equal(f.state.deletes.length,0,'removal requires explicit confirmation');f.state.fail='delete';await f.page.getByRole('button',{name:'Delete photo',exact:true}).click();await f.page.getByText('Your photo is hidden while deletion finishes. Retry removal before adding a new one.',{exact:true}).waitFor();assert.equal(await f.page.getByRole('button',{name:'Choose a photo',exact:true}).count(),0);
  await f.page.getByRole('button',{name:'Delete photo',exact:true}).click();await f.page.getByRole('button',{name:'Choose a photo',exact:true}).waitFor();assert.equal(f.state.deletes.length,2);assert.deepEqual(f.state.deletes[0],f.state.deletes[1]);await f.close();
 });
 await test('stale photo deletion requires a fresh confirmation for the newly discovered version',async()=>{
  const f=await fixture('ready');const oldVersion=f.state.version;await f.page.getByRole('button',{name:'Remove photo',exact:true}).click();f.state.fail='stale-delete';await f.page.getByRole('button',{name:'Delete photo',exact:true}).click();await f.page.getByRole('button',{name:'Remove photo',exact:true}).waitFor();assert.notEqual(f.state.version,oldVersion);assert.equal(await f.page.getByRole('button',{name:'Delete photo',exact:true}).count(),0);
  await f.page.getByRole('button',{name:'Remove photo',exact:true}).click();await f.page.getByRole('button',{name:'Delete photo',exact:true}).click();await f.page.getByRole('button',{name:'Choose a photo',exact:true}).waitFor();assert.equal(f.state.deletes.length,2);assert.notEqual(f.state.deletes[0].id,f.state.deletes[1].id);assert.notEqual(f.state.deletes[0].version,f.state.deletes[1].version);await f.close();
 });
 await test('non-image selection stays local and leaves the existing name and account intact',async()=>{
  const f=await fixture();await f.page.getByLabel('Choose profile photo',{exact:true}).setInputFiles({name:'fake.jpg',mimeType:'image/jpeg',buffer:Buffer.from('<svg><script>invalid</script></svg>')});await f.page.getByRole('alert').waitFor();assert.equal(f.state.uploads.length,0);assert.equal(f.state.profileWrites,0);assert.equal(await f.page.getByRole('button',{name:'Save photo',exact:true}).count(),0);assert.equal(await f.page.getByLabel('Display name',{exact:true}).inputValue(),'Alex');await f.close();
 });
 await test('account change during session lookup cannot upload or delete another user’s photo',async()=>{
  for(const action of ['Save photo','Delete photo']){
   const f=await fixture(action==='Delete photo'?'ready':'empty');
   if(action==='Save photo')await choose(f.page);else await f.page.getByRole('button',{name:'Remove photo',exact:true}).click();
   await f.page.evaluate(async()=>{
    const {client}=await import('/src/api.ts'),original=await client.auth.getSession();
    const user={...original.data.session.user,id:'00000000-0000-4000-8000-000000000002',email:'blake@example.test'};
    const changed={data:{session:{...original.data.session,user,access_token:'second-account-fixture-token'}},error:null};
    window.__photoSessionCalls=0;
    client.auth.getSession=()=>{window.__photoSessionCalls++;return window.__photoSessionCalls===1?new Promise(resolve=>{window.__resolvePhotoSession=()=>resolve(changed);}):Promise.resolve(changed);};
   });
   await f.page.getByRole('button',{name:action,exact:true}).click();
   await f.page.waitForFunction(()=>typeof window.__resolvePhotoSession==='function');
   assert.equal(f.state.uploads.length+f.state.deletes.length,0,'no write before session lookup completes');
   await f.page.evaluate(()=>window.__resolvePhotoSession());
   await f.page.getByRole('alert').getByText('Your account changed. Open your profile again before changing its photo.',{exact:true}).waitFor();
   assert.equal(f.state.uploads.length,0,'a draft selected by Alex cannot be uploaded with Blake’s session');
   assert.equal(f.state.deletes.length,0,'Alex’s confirmation cannot remove Blake’s current photo');
   assert.equal(f.state.profileWrites,0);await f.close();
  }
 });
 if(nameFilter)assert.ok(results.length,'No photo browser scenario matched the supplied name filter');
}finally{await browser.close();await server.close();}

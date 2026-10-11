// Synthetic browser/API fixtures exercise the production UI and client module.
// Native Push/Notification are mocked; this does not claim phone delivery coverage.
// Every non-local HTTP/WebSocket is blocked or explicitly fulfilled below.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PACT_PLAYWRIGHT_MODULE||'playwright');
const host='http://127.0.0.1:4190',fixtureUrl='https://pact-fixture.supabase.co';
const actor='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const eventId='00000000-0000-4000-8000-000000000003';
const vapid=Buffer.from([4,...new Array(64).fill(1)]).toString('base64url');
const server=await createServer({envDir:false,define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(fixtureUrl),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_fixture_only'),'import.meta.env.VITE_PROFILE_PHOTOS_ENABLED':'"false"','import.meta.env.VITE_NOTIFICATIONS_ENABLED':'"true"','import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY':JSON.stringify(vapid)},server:{host:'127.0.0.1',port:4190,strictPort:true}});await server.listen();
const browser=await chromium.launch({...(process.env.PACT_CHROMIUM_PATH?{executablePath:process.env.PACT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const results=[];mkdirSync('qa/artifacts',{recursive:true});
async function test(name,run){const start=Date.now();try{await run();results.push({name,status:'passed',ms:Date.now()-start});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:String(error)});throw error;}finally{writeFileSync('qa/artifacts/notifications-browser-results.json',JSON.stringify(results,null,2));}}
async function fixture({permission='default',permissionResult='granted',unsupported=false,ios=false,deferred=false,scheme='light',initialDevice=null,registration=false}={}){
 const state={calls:[],errors:[],unexpected:[],preferences:{expenses:true,refunds:true,repayments:true,tone:'friendly'},enabled:false,rejectOnce:'',navigation:{screen:'account',household:null}};
 const user={id:actor,aud:'authenticated',role:'authenticated',email:'alex@example.test',email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{provider:'google',providers:['google']},user_metadata:{full_name:'Alex'},created_at:'2026-10-01T00:00:00Z'};
 const session={access_token:[{alg:'HS256',typ:'JWT'},{sub:actor,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'fixture'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.'),refresh_token:'fixture-local-only',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user};
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:scheme,reducedMotion:'reduce'});
 await context.addInitScript(({session,permission,permissionResult,unsupported,ios,deferred,initialDevice,registration})=>{
  localStorage.setItem('sb-pact-fixture-auth-token',JSON.stringify(session));
  if(initialDevice)localStorage.setItem('pact:push-device',typeof initialDevice==='string'?initialDevice:JSON.stringify(initialDevice));
  const state=window.__push={permission,permissionResult,permissionCalls:0,gestures:[],events:[],binding:null,hasRegistration:registration,hasSubscription:false,unsubscribeResult:true,ackResult:true,closed:0,deferred,resolvePermission:null,subscriptionBarrier:null,resolveSubscription:null};
  if(ios){Object.defineProperty(navigator,'userAgent',{value:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'});Object.defineProperty(navigator,'platform',{value:'iPhone'});}
  if(unsupported){delete window.Notification;delete window.PushManager;}else{
   class FakeNotification {static get permission(){return state.permission;}static requestPermission(){state.permissionCalls++;state.gestures.push(navigator.userActivation.isActive);state.events.push('permission');if(state.deferred)return new Promise(resolve=>{state.resolvePermission=value=>{state.permission=value;resolve(value);};});state.permission=state.permissionResult;return Promise.resolve(state.permission);}}
   Object.defineProperty(window,'Notification',{value:FakeNotification,configurable:true});Object.defineProperty(window,'PushManager',{value:class{},configurable:true});
  }
  const subscription={toJSON(){return {endpoint:'https://push.example.test/synthetic',keys:{p256dh:'synthetic-key',auth:'synthetic-auth'}};},async unsubscribe(){state.events.push('unsubscribe');if(state.unsubscribeResult)state.hasSubscription=false;return state.unsubscribeResult;}};
  const reg={active:{postMessage(message,ports){state.events.push(message.binding===null?'clear-binding':'set-binding');if(state.ackResult)state.binding=message.binding;queueMicrotask(()=>ports[0].postMessage({ok:state.ackResult}));}},pushManager:{async getSubscription(){return state.hasSubscription?subscription:null;},async subscribe(options){state.events.push('subscribe');state.subscriptionOptions={userVisibleOnly:options.userVisibleOnly,keyBytes:options.applicationServerKey.length};if(state.subscriptionBarrier)await state.subscriptionBarrier;state.hasSubscription=true;return subscription;}},async getNotifications(){return [{close(){state.closed++;state.events.push('close');}}];}};
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{async getRegistration(){return state.hasRegistration?reg:undefined;},async register(url,options){state.events.push('register-worker');state.worker={url,options};state.hasRegistration=true;return reg;},get ready(){return Promise.resolve(reg);}}});
 },{session,permission,permissionResult,unsupported,ios,deferred,initialDevice,registration});
 await context.routeWebSocket(/^wss:/,ws=>ws.close());
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin===host)return route.continue();
  if(url.origin!==fixtureUrl){state.unexpected.push(url.origin+url.pathname);return route.abort();}
  const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body),headers:{'access-control-allow-origin':host}});
  if(request.method()==='OPTIONS')return respond({});
  if(url.pathname==='/auth/v1/user')return respond(user);
  if(url.pathname==='/auth/v1/logout'){state.calls.push({name:'logout'});return respond({});}
  if(url.pathname==='/auth/v1/authorize'){state.calls.push({name:'oauth'});return route.fulfill({contentType:'text/html',body:'<title>Synthetic sign-in</title><p>Synthetic sign-in</p>'});}
  if(url.pathname==='/rest/v1/groups')return respond([]);
  if(url.pathname==='/rest/v1/profiles')return respond({id:actor,display_name:'Alex'});
  if(!url.pathname.startsWith('/rest/v1/rpc/')){state.unexpected.push(url.pathname);return route.abort();}
  const name=url.pathname.split('/').at(-1),args=request.postDataJSON();state.calls.push({name,args});
  if(state.rejectOnce===name){state.rejectOnce='';return respond({code:'P0001',message:name==='send_test_notification'?'push_test_rate_limit':'push_device_conflict'},400);}
  if(name==='get_notification_preferences')return respond(state.preferences);
  if(name==='set_notification_preferences'){state.preferences={expenses:args.p_expenses,refunds:args.p_refunds,repayments:args.p_repayments,tone:args.p_tone};return respond(state.preferences);}
  if(name==='get_push_subscription')return respond({enabled:state.enabled});
  if(name==='register_push_subscription'){state.enabled=true;return respond({enabled:true});}
  if(name==='revoke_push_subscription'){state.enabled=false;return respond(null);}
  if(name==='get_payment_preferences')return respond({require_payment_approval:false});
  if(name==='send_test_notification')return respond(eventId);
  if(name==='resolve_notification')return respond(state.navigation);
  state.unexpected.push(name);return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>state.errors.push(String(error)));
 await page.goto(host+'/?screen=account');await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await page.getByText('Loading notification settings…',{exact:true}).waitFor({state:'hidden'});
 const settings=page.getByRole('region',{name:'Phone notifications',exact:true});
 return {page,settings,state,context,async close(){assert.deepEqual(state.errors,[]);assert.deepEqual(state.unexpected,[]);await context.close();}};
}
async function device(page){return page.evaluate(()=>({record:JSON.parse(localStorage.getItem('pact:push-device')||'null'),permissionCalls:__push.permissionCalls,gestures:__push.gestures,events:__push.events,binding:__push.binding,hasSubscription:__push.hasSubscription,closed:__push.closed,worker:__push.worker,subscriptionOptions:__push.subscriptionOptions}));}
async function enable(f){await f.settings.getByRole('button',{name:'Enable on this device',exact:true}).click();await f.settings.getByText('Notifications enabled for this device.',{exact:true}).waitFor();}
try{
 await test('Permission is requested only by Enable; categories, tone, test and off work in both themes',async()=>{
  for(const scheme of ['light','dark']){
   const f=await fixture({scheme}),{page,settings,state}=f;assert.equal((await device(page)).permissionCalls,0);
   assert.equal(await settings.getByRole('button',{name:'Save notification preferences',exact:true}).isDisabled(),true);
   await enable(f);const d=await device(page);assert.deepEqual(d.gestures,[true]);assert.deepEqual(d.subscriptionOptions,{userVisibleOnly:true,keyBytes:65});assert.deepEqual(d.worker,{url:'/push-sw.js',options:{scope:'/',updateViaCache:'none'}});assert.equal(d.record.userId,actor);assert.equal(d.binding,d.record.binding);assert.equal(state.calls.filter(c=>c.name==='register_push_subscription').length,1);
   await settings.getByRole('checkbox',{name:'Refunds',exact:true}).uncheck();await settings.getByRole('combobox',{name:/Notification tone/}).selectOption('brief');await settings.getByText('A transaction involving you changed. Open Pact to view it.',{exact:true}).waitFor();await settings.getByRole('button',{name:'Save notification preferences',exact:true}).click();await settings.getByText('Notification preferences saved for your devices.',{exact:true}).waitFor();assert.deepEqual(state.preferences,{expenses:true,refunds:false,repayments:true,tone:'brief'});
   await settings.getByRole('button',{name:'Send a test notification',exact:true}).click();await settings.getByText(/Test queued\./).waitFor();assert.equal(state.calls.filter(c=>c.name==='send_test_notification').length,1);
   await page.addScriptTag({content:readFileSync(process.env.PACT_AXE_PATH||fileURLToPath(import.meta.resolve('axe-core/axe.min.js')),'utf8')});const violations=await page.evaluate(async()=>{const result=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}));});assert.deepEqual(violations,[]);
   await settings.getByRole('button',{name:'Turn off on this device',exact:true}).click();await settings.getByText('Notifications turned off for this device.',{exact:true}).waitFor();const off=await device(page);assert.equal(off.record,null);assert.equal(off.binding,null);assert.equal(off.hasSubscription,false);assert.ok(off.events.indexOf('clear-binding')<off.events.indexOf('unsubscribe'));assert.ok(off.closed>0);assert.equal(state.enabled,false);await f.close();
  }
 });
 await test('Denied permission gives recovery guidance and never registers delivery',async()=>{
  const f=await fixture({permissionResult:'denied'});await f.settings.getByRole('button',{name:'Enable on this device',exact:true}).click();await f.settings.getByRole('alert').getByText(/Notifications are blocked/).waitFor();assert.equal((await device(f.page)).hasSubscription,false);assert.equal(f.state.calls.filter(c=>c.name==='register_push_subscription').length,0);await f.close();
 });
 await test('Unsupported and non-installed iOS browsers explain the next step without prompting',async()=>{
  for(const ios of [false,true]){const f=await fixture({unsupported:true,ios});await f.settings.getByText(ios?/On iPhone or iPad, add Pact to your Home Screen/:/This browser cannot receive Pact notifications/).waitFor();assert.equal(await f.settings.getByRole('button',{name:'Enable on this device'}).count(),0);assert.equal((await device(f.page)).permissionCalls,0);await f.close();}
 });
 await test('Sign-out and account selection detach device delivery before Auth handoff',async()=>{
  for(const action of ['Sign out','Switch Google account']){const f=await fixture();await enable(f);await f.page.getByRole('button',{name:action,exact:true}).click();await f.page.waitForFunction(()=>localStorage.getItem('pact:push-device')===null);await new Promise(resolve=>setTimeout(resolve,100));const calls=f.state.calls.map(c=>c.name);assert.ok(calls.includes(action==='Sign out'?'logout':'oauth'));assert.ok(calls.indexOf('revoke_push_subscription')<calls.indexOf(action==='Sign out'?'logout':'oauth'));if(action==='Sign out'){const d=await device(f.page);assert.equal(d.binding,null);assert.equal(d.hasSubscription,false);}await f.close();}
 });
 await test('Unsubscribe failure blocks sign-out and leaves an actionable error',async()=>{
  const f=await fixture();await enable(f);await f.page.evaluate(()=>{__push.unsubscribeResult=false;});await f.page.getByRole('button',{name:'Sign out',exact:true}).click();await f.page.getByRole('alert').getByText(/Could not disconnect this device/).waitFor();assert.equal(f.state.calls.filter(c=>c.name==='logout').length,0);assert.equal((await device(f.page)).binding,null);await f.close();
 });
 await test('A permission prompt spanning A to B to A cannot re-enable its stale account',async()=>{
  const f=await fixture({deferred:true});await f.settings.getByRole('button',{name:'Enable on this device',exact:true}).click();await f.page.waitForFunction(()=>typeof __push.resolvePermission==='function');await f.page.evaluate(async({actor,other})=>{const module=await import('/src/notifications.ts');await module.prepareNotificationAccount(other);await module.prepareNotificationAccount(actor);__push.resolvePermission('granted');},{actor,other});await f.settings.getByRole('alert').getByText(/Your account changed/).waitFor();assert.equal(f.state.calls.filter(c=>c.name==='register_push_subscription').length,0);assert.equal((await device(f.page)).hasSubscription,false);await f.close();
 });
 await test('Account change during subscription creation removes the late subscription',async()=>{
  const f=await fixture({permission:'granted'});await f.page.evaluate(()=>{__push.subscriptionBarrier=new Promise(resolve=>{__push.resolveSubscription=resolve;});});await f.settings.getByRole('button',{name:'Enable on this device',exact:true}).click();await f.page.waitForFunction(()=>__push.events.includes('subscribe'));await f.page.evaluate(async other=>{await (await import('/src/notifications.ts')).prepareNotificationAccount(other);__push.resolveSubscription();},other);await f.settings.getByRole('alert').getByText(/Your account changed/).waitFor();const d=await device(f.page);assert.equal(d.hasSubscription,false);assert.equal(d.binding,null);assert.equal(d.record,null);assert.equal(f.state.calls.filter(c=>c.name==='register_push_subscription').length,0);await f.close();
 });
 await test('Registration errors can reset and recover without raw database jargon',async()=>{
  const f=await fixture();f.state.rejectOnce='register_push_subscription';await f.settings.getByRole('button',{name:'Enable on this device',exact:true}).click();await f.settings.getByRole('alert').getByText(/needs a fresh start/).waitFor();await f.settings.getByRole('button',{name:'Reset device setup',exact:true}).click();await f.settings.getByText('Device setup cleared. You can enable notifications again.',{exact:true}).waitFor();assert.equal((await device(f.page)).record,null);await enable(f);f.state.rejectOnce='send_test_notification';await f.settings.getByRole('button',{name:'Send a test notification',exact:true}).click();await f.settings.getByRole('alert').getByText('Wait one minute before sending another test notification.',{exact:true}).waitFor();await f.close();
 });
 await test('Signed-in notification navigation validates route data and consumes its query',async()=>{
  const f=await fixture();const result=await f.page.evaluate(async eventId=>{history.replaceState({},'',`/?screen=account&notification=${eventId}`);return (await import('/src/notifications.ts')).resolveNotificationNavigation();},eventId);assert.deepEqual(result,{screen:'account',group:''});assert.equal(new URL(f.page.url()).searchParams.has('notification'),false);
  f.state.navigation={screen:'https://outside.example/',household:null};const error=await f.page.evaluate(async eventId=>{history.replaceState({},'',`/?notification=${eventId}`);try{await (await import('/src/notifications.ts')).resolveNotificationNavigation();return '';}catch(error){return error.message;}},eventId);assert.match(error,/no longer available/);assert.equal(new URL(f.page.url()).origin,host);await f.close();
 });
 console.log(`PASS ${results.length} notification browser scenarios (mocked native delivery)`);
}finally{await browser.close();await server.close();}

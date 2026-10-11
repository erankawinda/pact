// Every non-local HTTP/WebSocket is intercepted. Tests use a disposable PGlite
// database with the actual migrations; no hosted account or data is accessed.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PACT_PLAYWRIGHT_MODULE||'playwright');
// The fixture overrides every public connection value, even if .env.local exists.
const fixtureUrl='https://pact-fixture.supabase.co';
const axePath=process.env.PACT_AXE_PATH||fileURLToPath(import.meta.resolve('axe-core/axe.min.js'));
const server=await createServer({envDir:false,define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(fixtureUrl),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_fixture_only')},server:{host:'127.0.0.1',port:4173,strictPort:true}});await server.listen();
const browser=await chromium.launch({...(process.env.PACT_CHROMIUM_PATH?{executablePath:process.env.PACT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const host='http://127.0.0.1:4173',out='qa/artifacts/screenshots';mkdirSync(out,{recursive:true});
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];const names=['Alex','Blake','Casey','Devin'];const results=[];
async function fixture({empty=false,signedIn=true,width=390,scheme='light',requireApproval=false,extraMembers=0}={}){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 await db.exec(readFileSync('tests/fixtures/platform.sql','utf8'));
 for(const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 const members=[...ids.map((id,i)=>({id,name:names[i],email:`${names[i].toLowerCase()}@example.test`})),...Array.from({length:extraMembers},(_,i)=>({id:randomUUID(),name:`Example Housemate ${i+1}`,email:`extra${i+1}@example.test`}))];
 for(const member of members)await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)",[member.id,member.email,JSON.stringify({full_name:member.name})]);
 let queue=Promise.resolve();function sql(actor,query,args=[]){const run=queue.then(async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');return db.query(query,args);});queue=run.catch(()=>{});return run;}
 async function call(actor,name,args){assert.match(name,/^[a-z_]+$/);const keys=Object.keys(args);keys.forEach(k=>assert.match(k,/^p_[a-z_]+$/));const params=keys.map((k,i)=>`${k}=>$${i+1}`).join(',');const values=keys.map(k=>args[k]!==null&&typeof args[k]==='object'&&!Array.isArray(args[k])?JSON.stringify(args[k]):args[k]);const result=await sql(actor,`select public.${name}(${params}) as value`,values);return result.rows[0].value;}
 let home='',trip='';if(!empty){home=await call(ids[0],'create_space',{p_name:'Our home',p_kind:'household',p_parent:null,p_people:[],p_request:randomUUID()});for(const member of members.slice(1)){const token=await call(ids[0],'create_invitation',{p_group:home,p_email:member.email});await call(member.id,'accept_invitation',{p_token:token});}trip=await call(ids[0],'create_space',{p_name:'Weekend away',p_kind:'trip',p_parent:home,p_people:[ids[1]],p_request:randomUUID()});for(const [description,amount,payer,people,category,date] of [['Weekly groceries',8640,ids[0],ids,'groceries','2026-10-03'],['Friday takeout',5400,ids[1],ids.slice(0,3),'takeaway','2026-10-02']])await call(ids[0],'save_expense',{p_input:{p_group:home,p_request:randomUUID(),p_description:description,p_amount:amount,p_payer:payer,p_people:people,p_mode:'equal',p_exact:null,p_date:date,p_category:category,p_note:''}});}
 if(requireApproval)for(const actor of ids)await call(actor,'set_payment_preferences',{p_require_approval:true});
 const state={calls:[],errors:[],unexpected:[],abortOnce:'',authOnce:'',rejectOnce:'',hangOnce:'',delayInvite:0};const contexts=[];
 async function createPage(actor=ids[0],options={}){const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1,colorScheme:scheme,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write'],...options});contexts.push(context);const i=ids.indexOf(actor);const user={id:actor,aud:'authenticated',role:'authenticated',email:`${names[i].toLowerCase()}@example.test`,email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{provider:'google',providers:['google']},user_metadata:{full_name:names[i]},created_at:'2026-10-01T00:00:00Z'};const session={access_token:[{alg:'HS256',typ:'JWT'},{sub:actor,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'fixture'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.'),refresh_token:'local-only',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user};
 if(signedIn)await context.addInitScript(({session})=>{if(!localStorage.getItem('sb-pact-fixture-auth-token'))localStorage.setItem('sb-pact-fixture-auth-token',JSON.stringify(session));},{session});
 await context.routeWebSocket(/^wss:/,ws=>ws.close());
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===host)return route.continue();
  if(url.hostname!=='pact-fixture.supabase.co'){state.unexpected.push(url.origin+url.pathname);return route.abort();}
  const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body),headers:{'access-control-allow-origin':host}});
  if(request.method()==='OPTIONS')return respond({});
  if(url.pathname==='/auth/v1/user')return respond(user);
  if(url.pathname==='/auth/v1/logout')return respond({});
  if(url.pathname==='/auth/v1/authorize'){state.calls.push({name:'oauth',url:url.href});return route.fulfill({contentType:'text/html',body:'<title>Local sign-in handoff</title><p>Local sign-in handoff</p>'});}
  if(url.pathname==='/rest/v1/groups'){const result=await sql(actor,'select id,name,kind,archived_at,parent_household_id from public.groups order by created_at');return respond(result.rows);}
  if(url.pathname==='/rest/v1/profiles'&&request.method()==='GET'){
   // Execute the actual table read as this actor; never substitute Auth metadata
   // or bypass the migrations' row-level policy for a profile response.
   const select=(url.searchParams.get('select')??'id,display_name').split(',');
   assert.ok(select.length&&select.every(column=>['id','display_name'].includes(column)),'Unexpected profile projection');
   const idFilter=url.searchParams.get('id');assert.ok(!idFilter||/^eq\.[0-9a-f-]{36}$/i.test(idFilter),'Unexpected profile filter');
   state.calls.push({name:'get_profile',actor,select,id:idFilter?.slice(3)??null});
   try{
    const result=await sql(actor,`select ${select.join(',')} from public.profiles${idFilter?' where id=$1':''}`,idFilter?[idFilter.slice(3)]:[]);
    // single() requests an object; maybeSingle() accepts the ordinary array and
    // handles a zero-row response in supabase-js.
    if((request.headers().accept??'').includes('application/vnd.pgrst.object+json')){
     if(result.rows.length!==1)return respond({code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned',details:`The result contains ${result.rows.length} rows`},406);
     return respond(result.rows[0]);
    }
    return respond(result.rows);
   }catch(e){return respond({code:e.code??'P0001',message:e.message},400);}
  }
  const name=url.pathname.split('/').at(-1),args=request.postDataJSON();state.calls.push({name,args});
  if(state.hangOnce===name){state.hangOnce='';return;}
  if(state.authOnce===name){state.authOnce='';return respond({code:'PGRST301',message:'JWT expired'},401);}
  if(state.rejectOnce===name){state.rejectOnce='';return respond({code:'23514',message:'The profile could not be saved. Please try again.'},400);}
  try{if(name==='create_invitation'&&state.delayInvite)await new Promise(r=>setTimeout(r,state.delayInvite));const value=await call(actor,name,args);if(state.abortOnce===name){state.abortOnce='';return route.abort('failed');}return respond(value);}catch(e){return respond({code:e.code??'P0001',message:e.message},400);}
 });
 const page=await context.newPage();page.on('pageerror',e=>state.errors.push(String(e)));page.setDefaultTimeout(7000);await page.goto(host);await page.getByRole('button',{name:signedIn?(empty?'Create a household':'Add expense'):'Continue with Google',exact:true}).waitFor();return {page,context};}
 const first=await createPage();return {...first,state,db,call,home,trip,createPage,close:async()=>{for(const c of contexts)await c.close();await db.close();}};
}
const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true});
async function layout(page,label){const v=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(v.scroll<=v.width,`${label}: ${JSON.stringify(v)}`);}
async function reachable(locator,label){
 await locator.scrollIntoViewIfNeeded();
 const box=await locator.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {visible:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,uncovered:!!hit&&el.contains(hit),width:r.width,height:r.height};});
 assert.ok(box.visible&&box.uncovered,`${label}: ${JSON.stringify(box)}`);
}
async function navigationClearance(page,label){
 const navigation=page.getByRole('navigation',{name:'Main navigation'});
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
 const footer=await page.locator('.refresh-row').boundingBox(),bar=await navigation.boundingBox();
 assert.ok(footer&&bar&&footer.y+footer.height<=bar.y+1,`${label}: bottom navigation covers the refresh controls`);
 await reachable(page.getByRole('button',{name:'Refresh',exact:true}),`${label}: refresh`);
 for(const name of ['Home','Shopping','Expenses','Balances'])await reachable(nav(page,name),`${label}: ${name} navigation`);
 await page.evaluate(()=>window.scrollTo(0,0));
}
async function readableBalance(page,expected,label){
 const amount=page.locator('.balance-summary>strong');
 assert.equal((await amount.textContent()).trim(),expected,`${label}: complete amount`);
 const box=await amount.evaluate(el=>{const r=el.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth+1&&text.left>=r.left-1&&text.right<=r.right+1,scroll:el.scrollWidth,width:el.clientWidth,whiteSpace:getComputedStyle(el).whiteSpace};});
 assert.ok(box.inside&&box.scroll<=box.width+1,`${label}: clipped amount ${JSON.stringify(box)}`);
 assert.equal(box.whiteSpace,'nowrap',`${label}: amount must stay together`);
}
async function shot(page,label){
 await page.screenshot({path:`${out}/${label}.png`,fullPage:true,animations:'disabled'});
 // Matching phone viewports keep the README gallery aligned without stretching.
 if(['expense-review','shopping-needed','balances-dark'].includes(label)){
  assert.deepEqual(page.viewportSize(),{width:390,height:844});
  await page.evaluate(async()=>{window.scrollTo({top:0,behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  assert.equal(await page.evaluate(()=>window.scrollY),0,`${label}: gallery must start at the top`);
  const header=await page.locator('.topbar').boundingBox();assert.ok(header&&header.y>=0&&header.y+header.height<=844,`${label}: gallery header must be visible`);
  await page.screenshot({path:`${out}/${label}-preview.png`,fullPage:false,animations:'disabled'});
 }
}
async function test(name,run){const start=Date.now();try{await run();results.push({name,status:'passed',ms:Date.now()-start});console.log(`PASS ${name}`);}catch(e){console.error(`FAIL ${name}`,e);results.push({name,status:'failed',error:String(e)});throw e;}finally{writeFileSync('qa/artifacts/browser-results.json',JSON.stringify(results,null,2));}}
async function addExpense(page,{amount='10.01',name='Shared snack',people=['Blake','Casey']}={}){await page.getByRole('button',{name:'Add expense',exact:true}).click();await page.getByLabel('Amount · AUD').fill(amount);await page.getByLabel('What was it for?').fill(name);for(const who of people)await page.getByRole('checkbox',{name:who==='Alex'?'Alex You':who,exact:true}).check();}
async function openAccount(page){await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await page.getByLabel('Display name',{exact:true}).waitFor();await page.getByText('Loading your profile…',{exact:true}).waitFor({state:'hidden'});}
async function expectProfileName(page,value){const input=await page.getByLabel('Display name',{exact:true}).elementHandle();await page.waitForFunction(({input,value})=>input.value===value,{input,value});}
async function accessibility(page,label){await page.addScriptTag({content:readFileSync(axePath,'utf8')});const axe=await page.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));assert.deepEqual(axe.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),[],label);}
const appearanceOption=(page,value)=>page.getByRole('radio',{name:value[0].toUpperCase()+value.slice(1),exact:true});
async function selectedAppearance(page){return page.getByRole('group',{name:'Appearance',exact:true}).getByRole('radio',{checked:true}).inputValue();}
async function palette(page){return page.evaluate(()=>{const root=document.documentElement,style=getComputedStyle(root);return {ink:style.getPropertyValue('--ink').trim(),surface:style.getPropertyValue('--surface').trim(),scheme:style.colorScheme};});}
async function done(f){assert.deepEqual(f.state.errors,[]);assert.deepEqual(f.state.unexpected,[]);await f.close();}
try{
 await test('Navigation, search and details stay accessible in both themes at phone, tablet and desktop widths',async()=>{
  const f=await fixture(),{page}=f;
  await shot(page,'home-mobile');await nav(page,'Expenses').click();
  await page.getByRole('searchbox',{name:'Search expenses'}).fill('Takeout');assert.equal(await page.locator('.expense-row').count(),1);
  await page.locator('.expense-row summary').click();await page.getByText('Original split',{exact:true}).waitFor();
  await page.getByRole('searchbox').fill('');await shot(page,'expenses-mobile');
  for(const tab of ['Home','Shopping','Expenses','Balances']){
   await nav(page,tab).click();await page.getByRole('heading',{level:1}).waitFor();
   assert.equal(await nav(page,tab).getAttribute('aria-current'),'page');
   assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).locator('[aria-current=page]').count(),1);
   for(const scheme of ['light','dark']){
    await page.emulateMedia({colorScheme:scheme});
    for(const width of [320,390,768,1280]){
     await page.setViewportSize({width,height:844});
     await layout(page,`${tab}-${scheme}-${width}`);await navigationClearance(page,`${tab}-${scheme}-${width}`);
     if(width===320||width===1280)await accessibility(page,`${tab}-${scheme}-${width}`);
    }
   }
  }
  await page.setViewportSize({width:390,height:844});await shot(page,'balances-dark');
  await nav(page,'Home').focus();await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'Your household',exact:true}).waitFor();
  assert.equal(await nav(page,'Home').getAttribute('aria-current'),'page','Navigation works from the keyboard');
  await done(f);
 });
 await test('Balance text and complete amounts distinguish owed, owing and settled states',async()=>{
  const f=await fixture({width:320,extraMembers:8}),{page:owing}=await f.createPage(ids[2]);
  const longGroup='Our Very Long Example Household Name For The Narrow Phone Header';
  await f.call(ids[0],'group_action',{p_group:f.home,p_action:'rename',p_target:null,p_value:longGroup,p_request:randomUUID()});
  await f.page.getByRole('button',{name:'Refresh',exact:true}).click();await owing.getByRole('button',{name:'Refresh',exact:true}).click();
  async function check(page,label,amount,state){
   await nav(page,'Balances').click();await page.locator('.balance-summary').getByText(label,{exact:true}).waitFor();
   for(const scheme of ['light','dark']){
    await page.emulateMedia({colorScheme:scheme});
    for(const width of [320,390]){await page.setViewportSize({width,height:844});await layout(page,`${state}-${scheme}-${width}`);await readableBalance(page,amount,`${state}-${scheme}-${width}`);}
    await accessibility(page,`${state}-${scheme}`);await shot(page,`balance-${state}-${scheme}`);
   }
  }
  await check(f.page,'You are owed','$46.80','owed');await check(owing,'You owe','$39.60','owing');
  await f.call(ids[2],'record_repayment',{p_group:f.home,p_other:ids[0],p_direction:'sent',p_amount:3960,p_date:'2026-10-11',p_note:'Synthetic settlement',p_separate:false,p_request:randomUUID()});
  await owing.getByRole('button',{name:'Refresh',exact:true}).click();
  await check(owing,'All settled up','$0.00','settled');
  await f.page.setViewportSize({width:320,height:844});
  const people=f.page.getByRole('button',{name:'People: 12 active members',exact:true});await reachable(people,'12-person household header');
  await f.page.getByRole('button',{name:'Household menu',exact:true}).click();
  await f.page.getByRole('button',{name:'Weekend away',exact:true}).click();await f.page.getByRole('heading',{name:'Your trip',exact:true}).waitFor();
  await f.page.getByRole('button',{name:'People: 2 active members',exact:true}).waitFor();
  for(const scheme of ['light','dark']){await f.page.emulateMedia({colorScheme:scheme});await layout(f.page,`trip header320-${scheme}`);await accessibility(f.page,`trip header320-${scheme}`);}
  await shot(f.page,'trip-header-320');await done(f);
 });
 await test('Exact shares, payer excluded, draft survives browser Back and reload',async()=>{const f=await fixture();const {page}=f;await addExpense(page);assert.match(await page.locator('.split-list').innerText(),/\$5.01/);await page.getByRole('button',{name:'Custom amounts',exact:true}).click();await page.getByLabel("Blake's share",{exact:true}).fill('10.01');assert.match(await page.locator('.split-status').innerText(),/1 share calculated automatically/);assert.equal(await page.getByLabel("Casey's share",{exact:true}).inputValue(),'0.00');await page.getByLabel("Casey's share",{exact:true}).fill('0');assert.match(await page.locator('.split-status').innerText(),/Total matches/);await page.goBack();await page.getByRole('button',{name:'Add expense',exact:true}).click();assert.equal(await page.getByLabel('What was it for?').inputValue(),'Shared snack');await page.reload();await page.getByLabel('What was it for?').waitFor();assert.equal(await page.getByLabel('Amount · AUD').inputValue(),'10.01');await shot(page,'expense-form');await page.getByRole('button',{name:'Review expense'}).click();await shot(page,'expense-review');await page.getByRole('button',{name:'Save expense',exact:true}).click();await page.getByText('Expense saved.',{exact:true}).waitFor();const calls=f.state.calls.filter(c=>c.name==='save_expense');assert.equal(calls.length,1);assert.deepEqual(calls[0].args.p_input.p_people,ids.slice(1,3));const s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});const e=s.expenses.find(e=>e.description==='Shared snack');assert.equal(e.amount_cents,1001);assert.deepEqual(s.shares.filter(v=>v.expense_id===e.id).map(v=>Number(v.share_cents)).sort((a,b)=>a-b),[0,1001]);await done(f);});
 await test('Custom remainder recalculates, preserves manual zero, survives edits and saves exact cents',async()=>{
  const f=await fixture();const {page}=f;
  await addExpense(page,{amount:'100.01',name:'Custom remainder',people:names});
  await page.getByRole('button',{name:'Custom amounts',exact:true}).click();
  const share=name=>page.getByLabel(`${name}'s share`,{exact:true});
  await share('Alex').fill('20');await share('Blake').fill('30');
  assert.equal(await share('Casey').inputValue(),'');
  assert.match(await page.locator('.split-status').innerText(),/2 people/);
  await page.getByRole('button',{name:'Split remaining equally',exact:true}).click();
  assert.equal(await share('Casey').inputValue(),'25.01');assert.equal(await share('Devin').inputValue(),'25.00');
  await page.getByLabel('Amount · AUD').fill('40');
  assert.match(await page.locator('.split-status').innerText(),/\$10.00 over/);
  assert.equal(await share('Casey').inputValue(),'');assert.equal(await share('Devin').inputValue(),'');
  await page.getByRole('button',{name:'Review expense',exact:true}).click();
  assert.match(await page.getByRole('alert').innerText(),/\$10.00 over/);
  assert.equal(f.state.calls.filter(c=>c.name==='save_expense').length,0);
  await page.getByLabel('Amount · AUD').fill('100.01');
  // Typing over a calculated value must start a manual value, not append to it.
  await share('Casey').click();await share('Casey').pressSequentially('10');
  assert.equal(await share('Casey').inputValue(),'10');assert.equal(await share('Devin').inputValue(),'40.01');
  await share('Casey').fill('0');assert.equal(await share('Devin').inputValue(),'50.01');
  assert.equal(await page.locator('.auto-share-label').count(),1);
  await share('Casey').fill('');await page.getByRole('heading',{name:'Add an expense',exact:true}).click();
  assert.equal(await share('Casey').inputValue(),'25.01');
  await page.getByRole('checkbox',{name:'Blake',exact:true}).uncheck();
  assert.equal(await share('Casey').inputValue(),'40.01');assert.equal(await share('Devin').inputValue(),'40.00');
  await page.getByRole('checkbox',{name:'Blake',exact:true}).check();
  assert.equal(await share('Blake').inputValue(),'30');assert.equal(await share('Casey').inputValue(),'25.01');
  await page.reload();await share('Casey').waitFor();
  assert.equal(await share('Casey').inputValue(),'25.01');assert.equal(await page.locator('.auto-share-label').count(),2);
  // Mode changes and selection controls must keep entered amounts separate from
  // calculated shares, including when all inputs temporarily disappear.
  await page.getByRole('button',{name:'Equally',exact:true}).click();
  assert.equal(await page.locator('.exact-input input').count(),0);
  await page.getByRole('button',{name:'Custom amounts',exact:true}).click();
  assert.equal(await share('Alex').inputValue(),'20');assert.equal(await share('Blake').inputValue(),'30');
  assert.equal(await share('Casey').inputValue(),'25.01');assert.equal(await share('Devin').inputValue(),'25.00');
  await page.getByRole('button',{name:'Clear',exact:true}).click();
  assert.match(await page.locator('.split-status').innerText(),/No one selected/);
  assert.equal(await page.locator('.exact-input input').count(),0);assert.equal(await page.locator('.auto-share-label').count(),0);
  await page.getByRole('button',{name:'Select all',exact:true}).click();
  assert.equal(await share('Alex').inputValue(),'20');assert.equal(await share('Blake').inputValue(),'30');
  assert.equal(await share('Casey').inputValue(),'25.01');assert.equal(await share('Devin').inputValue(),'25.00');
  const refreshed=page.waitForResponse(response=>response.url().endsWith('/rest/v1/rpc/get_household_state'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;
  assert.equal(await share('Alex').inputValue(),'20');assert.equal(await share('Casey').inputValue(),'25.01');
  assert.equal(await page.locator('.auto-share-label').count(),2);
  await page.getByRole('button',{name:'Review expense',exact:true}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await page.locator('.auto-share-label').count(),2);
  await page.getByLabel('Amount · AUD').fill('120.01');
  assert.equal(await share('Alex').inputValue(),'20.00');assert.equal(await share('Blake').inputValue(),'30.00');
  assert.equal(await share('Casey').inputValue(),'35.01');assert.equal(await share('Devin').inputValue(),'35.00');
  for(const width of [320,390,768]){await page.setViewportSize({width,height:844});await layout(page,`custom remainder ${width}`);}
  await page.setViewportSize({width:390,height:844});
  for(const scheme of ['light','dark']){
   await page.emulateMedia({colorScheme:scheme});
   await accessibility(page,`custom split ${scheme}`);
   await shot(page,`custom-remainder-${scheme}`);
  }
  await page.getByRole('button',{name:'Review expense',exact:true}).click();await page.getByRole('button',{name:'Save expense',exact:true}).click();
  await page.getByText('Expense saved.',{exact:true}).waitFor();
  const state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  const expense=state.expenses.find(e=>e.description==='Custom remainder');assert.equal(expense.amount_cents,12001);
  const shares=Object.fromEntries(state.shares.filter(v=>v.expense_id===expense.id).map(v=>[v.user_id,Number(v.share_cents)]));
  assert.deepEqual(shares,{[ids[0]]:2000,[ids[1]]:3000,[ids[2]]:3501,[ids[3]]:3500});
  await done(f);
 });
 await test('Known custom shares suggest a total and one blank automatically takes the remainder',async()=>{
  const f=await fixture();const {page}=f;
  await addExpense(page,{amount:'',name:'Known shares',people:names});await page.getByRole('button',{name:'Custom amounts',exact:true}).click();
  for(const [name,value] of [['Alex','20'],['Blake','30'],['Casey','58']])await page.getByLabel(`${name}'s share`,{exact:true}).fill(value);
  assert.equal(await page.getByRole('button',{name:/Use .* as total/}).count(),0);
  await page.getByLabel("Devin's share",{exact:true}).fill('30');
  await page.getByRole('button',{name:'Use $138.00 as total',exact:true}).click();
  assert.equal(await page.getByLabel('Amount · AUD').inputValue(),'138.00');
  assert.match(await page.locator('.split-status').innerText(),/Total matches/);
  await page.getByLabel("Casey's share",{exact:true}).fill('');
  await page.getByRole('heading',{name:'Add an expense',exact:true}).click();
  assert.equal(await page.getByLabel("Casey's share",{exact:true}).inputValue(),'58.00');
  assert.equal(await page.locator('.auto-share-label').count(),1);
  await page.getByLabel('Amount · AUD').fill('150');
  assert.equal(await page.getByLabel("Casey's share",{exact:true}).inputValue(),'70.00');
  await page.getByLabel("Casey's share",{exact:true}).fill('1.001');
  assert.equal(await page.getByLabel("Casey's share",{exact:true}).getAttribute('aria-invalid'),'true');
  await page.getByRole('button',{name:'Review expense',exact:true}).click();
  assert.match(await page.getByRole('alert').innerText(),/two decimal/);
  await page.getByLabel("Casey's share",{exact:true}).fill('');
  await page.getByRole('button',{name:'Review expense',exact:true}).click();
  assert.equal(await page.locator('.review-amount').innerText(),'$150.00');
  await page.getByRole('button',{name:'Save expense',exact:true}).click();await page.getByText('Expense saved.',{exact:true}).waitFor();
  const call=f.state.calls.filter(c=>c.name==='save_expense').at(-1);
  assert.deepEqual(call.args.p_input.p_exact,{[ids[0]]:2000,[ids[1]]:3000,[ids[2]]:7000,[ids[3]]:3000});
  await done(f);
 });
 await test('Unconfirmed committed expense survives closing a tab; retry has one ledger entry',async()=>{const f=await fixture();let page=f.page;f.state.abortOnce='save_expense';await addExpense(page,{name:'Lost response'});await page.getByRole('button',{name:'Custom amounts',exact:true}).click();await page.getByLabel("Blake's share",{exact:true}).fill('4');assert.equal(await page.getByLabel("Casey's share",{exact:true}).inputValue(),'6.01');await page.getByRole('button',{name:'Review expense'}).click();await page.getByRole('button',{name:'Save expense',exact:true}).click();await page.getByRole('button',{name:'Check this save',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Back',exact:true}).isDisabled(),false);await page.close();page=await f.context.newPage();await page.goto(host);await page.getByRole('button',{name:'Check save',exact:true}).click();await page.getByRole('button',{name:'Check this save',exact:true}).click();await page.getByText('Expense saved.',{exact:true}).waitFor();const calls=f.state.calls.filter(c=>c.name==='save_expense');assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);assert.deepEqual(calls[0].args.p_input.p_exact,{[ids[1]]:400,[ids[2]]:601});const s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(s.expenses.filter(e=>e.description==='Lost response').length,1);await done(f);});
 await test('Save deadline leaves recoverable state and expired authentication offers sign-in',async()=>{const f=await fixture();const {page}=f;await addExpense(page,{name:'Timeout test'});await page.getByRole('button',{name:'Review expense'}).click();await page.clock.install();f.state.hangOnce='save_expense';await page.getByRole('button',{name:'Save expense',exact:true}).click();await page.waitForFunction(()=>!!Object.keys(localStorage).find(k=>k.startsWith('pact:pending-expense:')));await page.clock.fastForward(31000);await page.getByRole('button',{name:'Check this save',exact:true}).waitFor();f.state.authOnce='save_expense';await page.getByRole('button',{name:'Check this save',exact:true}).click();await page.getByRole('button',{name:'Sign in again',exact:true}).waitFor();assert.ok(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('pact:pending-expense:'))));await page.getByRole('button',{name:'Check this save',exact:true}).click();await page.getByText('Expense saved.',{exact:true}).waitFor();await done(f);});
 await test('Invitation opened in active app, account switching preserves link, busy email is frozen',async()=>{const f=await fixture();const {page}=f;const token='a'.repeat(64);await page.evaluate(t=>{location.hash='invite='+t;},token);await page.getByRole('heading',{name:'Join your people'}).waitFor();assert.equal(await page.getByLabel('Invitation link or code').inputValue(),token);await page.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await page.evaluate(()=>sessionStorage.getItem('our-place-invite')),token);await page.evaluate(t=>{location.hash='invite='+t;},token);await page.getByRole('button',{name:'Use a different Google account'}).click();await page.getByText('Local sign-in handoff',{exact:true}).waitFor();assert.match(f.state.calls.find(c=>c.name==='oauth').url,/prompt=select_account/);await page.goto(host);await page.getByRole('heading',{name:'Join your people'}).waitFor();assert.equal(await page.getByLabel('Invitation link or code').inputValue(),token);await page.evaluate(()=>sessionStorage.removeItem('our-place-invite'));await page.goto(host);await page.getByRole('button',{name:'People & trips',exact:true}).click();await page.getByRole('button',{name:'Invite a flatmate',exact:true}).click();await page.getByLabel('Google email').fill('new.person@example.test');f.state.delayInvite=300;await page.getByRole('button',{name:'Create invitation link'}).click();assert.equal(await page.getByLabel('Google email').isDisabled(),true);await page.getByRole('heading',{name:'Share the invitation'}).waitFor();assert.match(await page.locator('main').innerText(),/new.person@example.test/);await done(f);});
 await test('Shopping add, claim, partial buy, cost link, duplicate protection and undo',async()=>{const f=await fixture();const {page}=f;await nav(page,'Shopping').click();await page.getByRole('button',{name:'Add item',exact:true}).click();await page.getByLabel('Item',{exact:true}).fill('Milk');await page.getByLabel('Quantity',{exact:true}).fill('2');await page.getByLabel('Unit (optional)').fill('bottles');await page.getByRole('button',{name:'Add to list',exact:true}).click();await page.getByRole('button',{name:'I’ll get it'}).click();await page.getByText('You’re getting this',{exact:true}).waitFor();await page.getByText('Bought part of it?',{exact:true}).click();await page.getByLabel('Quantity bought').fill('1');await page.getByRole('button',{name:'Save quantity',exact:true}).click();await page.getByRole('button',{name:'Bought · 1',exact:true}).click();await page.getByRole('button',{name:'Add its cost'}).click();assert.equal(await page.getByLabel('What was it for?').inputValue(),'Milk');await page.getByLabel('Amount · AUD').fill('3');await page.getByRole('button',{name:'Select all',exact:true}).click();await page.getByRole('button',{name:'Review expense'}).click();await page.getByRole('button',{name:'Save expense',exact:true}).click();await page.getByText('Expense saved.',{exact:true}).waitFor();await nav(page,'Shopping').click();
  for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme});await page.getByRole('button',{name:'Mark bought',exact:true}).hover();await accessibility(page,`shopping mark bought hover ${scheme}`);}
  await page.mouse.move(0,0);await page.emulateMedia({colorScheme:'light'});await shot(page,'shopping-needed');await page.getByRole('button',{name:'Bought · 1'}).click();assert.equal(await page.getByRole('button',{name:'Add its cost'}).count(),0);await page.getByRole('button',{name:'Undo',exact:true}).click();await page.getByRole('button',{name:'Undo purchase',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/void.*linked expense/i);await shot(page,'shopping-purchased');const s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(Number(s.shopping[0].remaining),1);assert.equal(s.purchases.length,1);assert.ok(s.purchases[0].expense_id);await done(f);});
 await test('Repayment recorded by sender and confirmed by recipient; balances change only on confirmation',async()=>{const f=await fixture({requireApproval:true});const {page:sender}=await f.createPage(ids[2]);await nav(sender,'Balances').click();await sender.getByRole('button',{name:'I paid',exact:true}).click();await sender.getByLabel('Paid to').selectOption(ids[0]);await sender.getByLabel('Amount · AUD').fill('39.60');await sender.getByRole('button',{name:'Record repayment',exact:true}).click();await sender.getByRole('heading',{name:'Balances',exact:true}).waitFor();let s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(Number(s.balances.find(b=>b.user_id===ids[2]).cents),-3960);const {page}=f;await nav(page,'Balances').click();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Confirm received',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm received',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('heading',{name:'Waiting for confirmation'}).waitFor({state:'hidden'});s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(Number(s.balances.find(b=>b.user_id===ids[2]).cents),0);assert.equal(s.payments[0].status,'confirmed');await shot(page,'repayment-confirmed');await done(f);});
 await test('Expense correction keeps old record, refunds adjust balances, CSV exports safely',async()=>{const f=await fixture();const {page}=f;await nav(page,'Expenses').click();const row=page.locator('.expense-row').filter({hasText:'Weekly groceries'});await row.locator('summary').click();await row.getByRole('button',{name:'Correct expense'}).click();await page.getByLabel('Amount · AUD').fill('80');await page.getByLabel('Reason for correction').fill('Correct receipt total');await page.getByRole('button',{name:'Review expense'}).click();await page.getByRole('button',{name:'Save expense',exact:true}).click();await page.getByText('Expense saved.',{exact:true}).waitFor();let s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(s.expenses.filter(e=>e.description==='Weekly groceries').length,2);await page.locator('.expense-row').filter({hasText:'Weekly groceries'}).filter({hasText:'Voided · kept in history'}).waitFor({state:'visible'});const corrected=page.locator('.expense-row').filter({hasText:'Weekly groceries'}).filter({hasNotText:'Voided · kept in history'});await corrected.locator('summary').click();await corrected.getByRole('button',{name:'Record refund'}).click();await page.getByRole('dialog').getByLabel('Amount · AUD').fill('4');await page.getByRole('dialog').getByLabel('Reason').fill('Returned item');
  for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme});for(const width of [320,390]){await page.setViewportSize({width,height:568});await layout(page,`refund dialog-${scheme}-${width}`);await reachable(page.getByRole('dialog').getByRole('button',{name:'Record refund'}),`refund dialog submit-${scheme}-${width}`);}await accessibility(page,`refund dialog-${scheme}`);}
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Record refund',exact:true}).evaluate(el=>el===document.activeElement),true,'Dialog actions remain keyboard reachable');
  await page.setViewportSize({width:390,height:844});await page.getByRole('dialog').getByRole('button',{name:'Record refund'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});s=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(s.refunds[0].amount_cents,400);assert.equal(s.refund_shares.reduce((a,v)=>a+Number(v.share_cents),0),400);await page.getByRole('button',{name:'Household menu',exact:true}).click();await page.getByRole('button',{name:'Settings & exports'}).click();const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download CSV'}).click();const file=await downloading;const path=await file.path();const csv=readFileSync(path,'utf8');assert.match(csv,/Expense share/);assert.match(csv,/Refund share/);assert.match(csv,/Correct receipt total/);await done(f);});
 await test('Trip selection includes chosen household members and membership changes update an open expense form',async()=>{const f=await fixture();const {page}=f;await page.getByRole('button',{name:'People & trips',exact:true}).click();await page.getByRole('button',{name:'Create trip',exact:true}).click();await page.getByLabel('Trip name').fill('Coast weekend');await page.getByRole('checkbox',{name:'Casey',exact:true}).check();await page.getByRole('button',{name:'Create trip',exact:true}).click();await page.getByRole('heading',{name:'People & trips'}).waitFor();const call=f.state.calls.filter(c=>c.name==='create_space').at(-1);assert.deepEqual(call.args.p_people,[ids[2]]);await page.getByRole('button',{name:'Household menu',exact:true}).click();await page.getByRole('button',{name:'Our home',exact:true}).click();await addExpense(page,{name:'Membership changes',people:['Casey']});await page.getByRole('button',{name:'Custom amounts',exact:true}).click();assert.equal(await page.getByLabel("Casey's share",{exact:true}).inputValue(),'10.01');await f.call(ids[0],'group_action',{p_group:f.home,p_action:'remove_member',p_target:ids[2],p_value:'',p_request:randomUUID()});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('The people in this household changed.',{exact:false}).waitFor();assert.equal(await page.getByRole('checkbox',{name:'Casey',exact:true}).count(),0);assert.match(await page.locator('.split-status').innerText(),/No one selected/);assert.equal(await page.locator('.exact-input input').count(),0);assert.equal(await page.locator('.auto-share-label').count(),0);await done(f);});
 await test('Large balances remain unbroken at 320px; realtime fallback refreshes on focus',async()=>{const f=await fixture({width:320});await f.call(ids[0],'save_expense',{p_input:{p_group:f.home,p_request:randomUUID(),p_description:'Large test purchase',p_amount:100000000,p_payer:ids[0],p_people:[ids[1]],p_mode:'equal',p_exact:null,p_date:'2026-10-05',p_category:'other',p_note:''}});await f.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await f.page.getByText('$1,000,046.80',{exact:true}).waitFor();for(const scheme of ['light','dark']){await f.page.emulateMedia({colorScheme:scheme});await layout(f.page,`large balance320 ${scheme}`);await readableBalance(f.page,'$1,000,046.80',`large balance320 ${scheme}`);}await shot(f.page,'large-balance-320');await done(f);});
 await test('Recipient records a partial payment, both accounts see exact balances, and reversal preserves history',async()=>{
  const f=await fixture(),{page}=f,{page:sender}=await f.createPage(ids[2]);
  await nav(page,'Balances').click();await nav(sender,'Balances').click();
  await page.locator('.payment-card').filter({hasText:'Casey → Alex'}).getByRole('button',{name:'I received this',exact:true}).click();
  assert.equal(await page.getByLabel('Received from').inputValue(),ids[2]);
  assert.equal(await page.getByLabel('Amount · AUD').inputValue(),'39.60');
  const submit=page.getByRole('button',{name:'Confirm money received',exact:true});
  assert.equal(await submit.isDisabled(),true);
  await page.getByLabel('Amount · AUD').fill('10.01');
  await page.getByLabel('Date',{exact:true}).fill('2026-10-11');
  for(const width of [320,390,768]){await page.setViewportSize({width,height:844});await layout(page,`received payment ${width}`);}
  await page.setViewportSize({width:390,height:844});
  for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme});await accessibility(page,`received payment ${scheme}`);await shot(page,`received-payment-${scheme}`);}
  await page.getByRole('checkbox',{name:'I confirm I have received this money.',exact:true}).check();
  await submit.click();await page.getByRole('heading',{name:'Balances',exact:true}).waitFor();
  let state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments.length,1);assert.equal(state.payments[0].status,'confirmed');
  assert.equal(state.payments[0].recorded_by,ids[0]);assert.equal(state.payments[0].amount_cents,1001);
  assert.equal(Number(state.balances.find(b=>b.user_id===ids[0]).cents),3679);
  assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),-2959);
  assert.equal(state.activity.filter(a=>a.action==='payment_received').length,1);
  await sender.getByRole('button',{name:'Refresh',exact:true}).click();
  await sender.locator('.balance-summary>strong').filter({hasText:'$29.59'}).waitFor();
  await page.getByText('Repayment history',{exact:true}).click();
  await page.getByText('Recorded by Alex',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Reverse record',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Entered the wrong transfer');
  await page.getByRole('dialog').getByRole('button',{name:'Reverse repayment',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments.length,1);assert.equal(state.payments[0].status,'reversed');
  assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),-3960);
  await done(f);
 });
 await test('Recipient confirms an existing pending record instead of creating a second repayment',async()=>{
  const f=await fixture({requireApproval:true}),{page}=f;
  await f.call(ids[2],'record_payment',{p_group:f.home,p_recipient:ids[0],p_amount:3960,p_date:'2026-10-11',p_note:'Already sent',p_request:randomUUID()});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await nav(page,'Balances').click();await page.getByRole('button',{name:'I received',exact:true}).click();
  await page.getByLabel('Received from').selectOption(ids[2]);
  await page.getByRole('heading',{name:'Already waiting for confirmation',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Confirm money received',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('checkbox',{name:'I confirm I have received this money.',exact:true}).isDisabled(),true);
  await accessibility(page,'pending received payment');await shot(page,'received-payment-pending');
  await page.getByRole('button',{name:'Confirm received',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Confirm received',exact:true}).click();
  await page.getByRole('heading',{name:'Balances',exact:true}).waitFor();
  const state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments.length,1);assert.equal(state.payments[0].status,'confirmed');
  assert.equal(state.payments[0].recorded_by,ids[2]);
  assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),0);
  assert.equal(f.state.calls.filter(c=>c.name==='record_repayment').length,0);
  await done(f);
 });
 await test('Matching transfers require explicit separate-payment confirmation; a stale form cannot duplicate a pending record',async()=>{
  const f=await fixture({requireApproval:true}),{page}=f;
  await f.call(ids[0],'record_repayment',{p_group:f.home,p_other:ids[2],p_direction:'received',p_amount:1000,p_date:'2026-10-11',p_note:'First transfer',p_separate:false,p_request:randomUUID()});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await nav(page,'Balances').click();await page.getByRole('button',{name:'I received',exact:true}).click();
  await page.getByLabel('Received from').selectOption(ids[2]);await page.getByLabel('Amount · AUD').fill('10');
  await page.getByLabel('Date',{exact:true}).fill('2026-10-11');
  await page.getByRole('heading',{name:'Check this existing record',exact:true}).waitFor();
  const submit=page.getByRole('button',{name:'Confirm money received',exact:true});
  await page.getByRole('checkbox',{name:'I confirm I have received this money.',exact:true}).check();
  assert.equal(await submit.isDisabled(),true);
  await page.getByRole('checkbox',{name:'This is a separate payment',exact:true}).check();
  assert.equal(await submit.isDisabled(),true,'Separate payment acknowledgment must require receipt confirmation again');
  await page.getByRole('checkbox',{name:'I confirm I have received this money.',exact:true}).check();
  await submit.click();await page.getByRole('heading',{name:'Balances',exact:true}).waitFor();
  let state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(state.payments.length,2);
  assert.equal(f.state.calls.filter(c=>c.name==='record_repayment').at(-1).args.p_separate,true);
  await page.getByRole('button',{name:'I received',exact:true}).click();
  await page.getByLabel('Received from').selectOption(ids[2]);await page.getByLabel('Amount · AUD').fill('5');
  await page.getByRole('checkbox',{name:'I confirm I have received this money.',exact:true}).check();
  // Another account writes after this form's snapshot. The server must reject
  // the receipt even when the already-pending payment has a different amount.
  await f.call(ids[2],'record_payment',{p_group:f.home,p_recipient:ids[0],p_amount:600,p_date:'2026-10-11',p_note:'Arrived while form was open',p_request:randomUUID()});
  await submit.click();
  await page.getByRole('alert').filter({hasText:'There is already a repayment from this person waiting for confirmation.'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Check action',exact:true}).count(),0);
  state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments.length,3);assert.equal(state.payments.filter(p=>p.status==='confirmed').length,2);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('heading',{name:'Already waiting for confirmation',exact:true}).waitFor();
  assert.equal(await submit.isDisabled(),true);await done(f);
 });
 await test('A lost recipient-save response survives reload and retries exactly once without changing balances twice',async()=>{
  const f=await fixture(),{page}=f;
  await nav(page,'Balances').click();await page.getByRole('button',{name:'I received',exact:true}).click();
  await page.getByLabel('Received from').selectOption(ids[2]);await page.getByLabel('Amount · AUD').fill('39.60');
  await page.getByRole('checkbox',{name:'I confirm I have received this money.',exact:true}).check();
  f.state.abortOnce='record_repayment';await page.getByRole('button',{name:'Confirm money received',exact:true}).click();
  await page.getByRole('button',{name:'Check action',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Received from').isDisabled(),true);
  assert.equal(await page.getByLabel('Amount · AUD').isDisabled(),true);
  await page.reload();await page.getByRole('button',{name:'Check action',exact:true}).click();
  await page.getByRole('button',{name:'Check action',exact:true}).waitFor({state:'hidden'});
  const calls=f.state.calls.filter(c=>c.name==='record_repayment');assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);
  const state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments.length,1);assert.equal(state.payments[0].status,'confirmed');
  assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),0);
  assert.equal(state.activity.filter(a=>a.action==='payment_received').length,1);
  await done(f);
 });
 await test('Sender payments settle automatically by default and lost responses recover without a second payment',async()=>{
  const f=await fixture(),{page}=await f.createPage(ids[2]);
  await nav(page,'Balances').click();await page.getByRole('button',{name:'I paid',exact:true}).click();
  await page.getByLabel('Paid to').selectOption(ids[0]);await page.getByLabel('Amount · AUD').fill('39.60');
  await page.getByText('Alex allows automatic settlement. Saving updates both people’s balances immediately.',{exact:true}).waitFor();
  f.state.abortOnce='record_repayment';await page.getByRole('button',{name:'Record repayment',exact:true}).click();
  await page.getByRole('button',{name:'Check action',exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Check action',exact:true}).click();
  await page.getByRole('button',{name:'Check action',exact:true}).waitFor({state:'hidden'});
  const state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments.length,1);assert.equal(state.payments[0].status,'confirmed');
  assert.equal(state.payments[0].confirmation_method,'automatic');assert.equal(state.payments[0].recorded_by,ids[2]);
  assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),0);
  const calls=f.state.calls.filter(c=>c.name==='record_repayment');assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);
  await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('heading',{name:'Balances',exact:true}).waitFor();await page.getByText('Repayment history',{exact:true}).click();
  await page.getByText('Settled automatically',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Confirm received',exact:true}).count(),0);
  await done(f);
 });
 await test('Recipients control their own approval preference; changing it leaves existing pending payments untouched',async()=>{
  const f=await fixture(),{page}=f,{page:sender}=await f.createPage(ids[2]);
  await openAccount(page);
  const requireApproval=page.getByRole('checkbox',{name:'Require my approval for repayments to me',exact:true});
  await requireApproval.waitFor();assert.equal(await requireApproval.isChecked(),false);
  await requireApproval.check();await page.getByRole('button',{name:'Save payment preference',exact:true}).click();
  await page.getByText('Payment preference saved.',{exact:true}).waitFor();await page.reload();
  await requireApproval.waitFor();assert.equal(await requireApproval.isChecked(),true);
  assert.equal(await f.call(ids[0],'get_payment_preferences',{}),true);
  assert.equal(await f.call(ids[2],'get_payment_preferences',{}),false,'One account cannot change the payer preference');
  for(const scheme of ['light','dark']){await page.emulateMedia({colorScheme:scheme});await accessibility(page,`payment approval ${scheme}`);await shot(page,`payment-preference-${scheme}`);}
  await sender.getByRole('button',{name:'Refresh',exact:true}).click();await nav(sender,'Balances').click();
  await sender.getByRole('button',{name:'I paid',exact:true}).click();
  await sender.getByLabel('Paid to').selectOption(ids[0]);await sender.getByLabel('Amount · AUD').fill('39.60');
  await sender.getByText('Alex requires approval. This repayment will wait for their confirmation before balances change.',{exact:true}).waitFor();
  await sender.getByRole('button',{name:'Record repayment',exact:true}).click();await sender.getByRole('heading',{name:'Balances',exact:true}).waitFor();
  let state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments[0].status,'pending');assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),-3960);
  await requireApproval.uncheck();await page.getByRole('button',{name:'Save payment preference',exact:true}).click();
  await page.getByText('Payment preference saved.',{exact:true}).waitFor();
  state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});assert.equal(state.payments[0].status,'pending');
  await page.getByRole('button',{name:'Pact home',exact:true}).click();await nav(page,'Balances').click();await page.getByRole('button',{name:'Confirm received',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Confirm received',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  state=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(state.payments[0].confirmation_method,'recipient');assert.equal(Number(state.balances.find(b=>b.user_id===ids[2]).cents),0);
  await done(f);
 });
 await test('Payment preference response loss preserves the chosen value for safe retry without affecting the ledger',async()=>{
  const f=await fixture(),{page}=f;await openAccount(page);
  const before=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  const checkbox=page.getByRole('checkbox',{name:'Require my approval for repayments to me',exact:true});
  await checkbox.check();f.state.abortOnce='set_payment_preferences';
  await page.getByRole('button',{name:'Save payment preference',exact:true}).click();
  await page.getByRole('alert').waitFor();assert.equal(await checkbox.isChecked(),true);
  await page.getByRole('button',{name:'Save payment preference',exact:true}).click();
  await page.getByText('Payment preference saved.',{exact:true}).waitFor();
  const calls=f.state.calls.filter(c=>c.name==='set_payment_preferences');assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);
  const after=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  for(const key of ['balances','expenses','payments','shares'])assert.deepEqual(after[key],before[key]);
  await done(f);
 });
 await test('Profile names trim and survive reload; members see refreshed names without email or ledger changes',async()=>{
  const f=await fixture(),{page}=f,other=await f.createPage(ids[1]);
  await other.page.getByRole('button',{name:'People & trips',exact:true}).click();
  await other.page.getByRole('heading',{name:'People & trips',exact:true}).waitFor();
  await other.page.clock.install();await other.page.clock.pauseAt(new Date(Date.now()+1000));
  assert.match(await other.page.locator('.member-card').first().innerText(),/Alex/);
  const before=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  const authBefore=await page.evaluate(()=>localStorage.getItem('sb-pact-fixture-auth-token'));
  await openAccount(page);await expectProfileName(page,'Alex');
  await page.getByLabel('Display name',{exact:true}).fill('  Alex Example  ');
  await page.getByRole('button',{name:'Save profile',exact:true}).click();
  await page.getByText('Profile saved.',{exact:true}).waitFor();await expectProfileName(page,'Alex Example');
  assert.deepEqual(f.state.calls.filter(c=>c.name==='update_profile').map(c=>c.args),[{p_display_name:'Alex Example'}]);
  assert.equal(await page.evaluate(()=>localStorage.getItem('sb-pact-fixture-auth-token')),authBefore,'Saving a profile must not replace the Auth session or Google metadata');
  assert.equal(await other.page.locator('.member-card .person-name').filter({hasText:'Alex Example'}).count(),0,'Other member retains the prior snapshot until it refreshes');
  await other.page.getByRole('button',{name:'Refresh',exact:true}).click();
  await other.page.locator('.member-card .person-name').filter({hasText:'Alex Example'}).waitFor();
  assert.doesNotMatch(await other.page.locator('main').innerText(),/@example\.test/,'Member screens must not expose account emails');
  const after=await f.call(ids[0],'get_household_state',{p_group:f.home,p_limit:50});
  assert.equal(after.members.find(m=>m.id===ids[0]).name,'Alex Example');
  assert.deepEqual(after.members.map(({id,role,status})=>({id,role,status})),before.members.map(({id,role,status})=>({id,role,status})));
  for(const key of ['balances','expenses','shares','payments'])assert.deepEqual(after[key],before[key],`Profile update changed ${key}`);
  for(const member of after.members)assert.deepEqual(Object.keys(member).sort(),['id','name','require_payment_approval','role','status']);
  await page.reload();await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await expectProfileName(page,'Alex Example');
  assert.ok(f.state.calls.filter(c=>c.name==='get_profile').every(c=>c.id===c.actor),'Account reads must target the signed-in profile');
  await done(f);
 });
 await test('Profile validation and server or authentication failure preserve the entered name for retry',async()=>{
  const f=await fixture(),{page}=f;await openAccount(page);await expectProfileName(page,'Alex');
  const field=page.getByLabel('Display name',{exact:true}),save=page.getByRole('button',{name:'Save profile',exact:true});
  await field.fill('   ');
  if(!await save.isDisabled())await save.click();
  assert.equal(f.state.calls.filter(c=>c.name==='update_profile').length,0,'Whitespace-only names must not be submitted');
  for(const failure of ['rejectOnce','authOnce']){
   const name=failure==='rejectOnce'?'Alex Retried':'Alex Renewed';
   await field.fill(name);f.state[failure]='update_profile';await save.click();
   await page.getByRole('alert').filter({hasText:failure==='authOnce'?'Your session has ended. Sign in again to continue.':'We could not complete that action. Please try again.'}).waitFor();
   assert.equal(await field.inputValue(),name);
   if(failure==='authOnce')await page.getByRole('button',{name:'Sign in again',exact:true}).waitFor();
   await save.click();await page.getByText('Profile saved.',{exact:true}).waitFor();await expectProfileName(page,name);
   const attempts=f.state.calls.filter(c=>c.name==='update_profile').slice(-2);
   assert.equal(attempts.length,2);assert.deepEqual(attempts.map(c=>c.args),[{p_display_name:name},{p_display_name:name}]);
  }
  await page.reload();await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await expectProfileName(page,'Alex Renewed');
  await done(f);
 });
 await test('A signed-in person without a household can edit their profile and keep appearance preference',async()=>{
  const f=await fixture({empty:true}),{page}=f;await openAccount(page);await expectProfileName(page,'Alex');
  await page.getByLabel('Display name',{exact:true}).fill('Alex New Home');
  await page.getByRole('button',{name:'Save profile',exact:true}).click();await page.getByText('Profile saved.',{exact:true}).waitFor();
  await appearanceOption(page,'dark').check();
  await page.reload();await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await expectProfileName(page,'Alex New Home');
  assert.equal(await selectedAppearance(page),'dark');
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark');
  assert.equal(await page.evaluate(()=>localStorage.getItem('pact:theme')),'dark');
  await page.getByRole('button',{name:'Pact home',exact:true}).click();await page.getByRole('button',{name:'Create a household',exact:true}).waitFor();
  assert.equal(f.state.calls.filter(c=>c.name==='create_space').length,0,'Profile changes must not create a household');
  await done(f);
 });
 await test('System, Light and Dark appearance persist, follow the intended scheme and fit long names accessibly',async()=>{
  const f=await fixture(),{page}=f,longName='Alexandria Example With A Long Household Display Name';
  await openAccount(page);await expectProfileName(page,'Alex');
  await page.getByLabel('Display name',{exact:true}).fill(longName);
  await page.getByRole('button',{name:'Save profile',exact:true}).click();await page.getByText('Profile saved.',{exact:true}).waitFor();
  assert.equal(await selectedAppearance(page),'system');
  await page.emulateMedia({colorScheme:'light'});const light=await palette(page);
  await page.emulateMedia({colorScheme:'dark'});const dark=await palette(page);assert.notDeepEqual(dark,light,'System appearance must react to an OS scheme change');
  const profileWrites=f.state.calls.filter(c=>c.name==='update_profile').length;
  for(const [choice,os,expected] of [['light','dark',light],['dark','light',dark],['system','light',light],['system','dark',dark]]){
   await appearanceOption(page,choice).check();await page.emulateMedia({colorScheme:os});
   assert.deepEqual(await palette(page),expected,`${choice} with OS ${os}`);
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme??null),choice==='system'?null:choice);
   const stored=await page.evaluate(()=>localStorage.getItem('pact:theme'));assert.ok(choice==='system'?stored===null||stored==='system':stored===choice);
   await page.reload();await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await expectProfileName(page,longName);
   assert.equal(await selectedAppearance(page),choice);assert.deepEqual(await palette(page),expected,`${choice} persists after reload`);
   for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});await layout(page,`profile-${choice}-${os}-${width}`);await accessibility(page,`profile-${choice}-${os}-${width}`);}
   if(choice==='light'||choice==='dark'){await page.setViewportSize({width:390,height:844});await shot(page,`profile-${choice}`);}
  }
  assert.equal(f.state.calls.filter(c=>c.name==='update_profile').length,profileWrites,'Appearance changes stay on this browser');
  await page.setViewportSize({width:390,height:844});await shot(page,'profile-dark');
  await page.getByRole('button',{name:'Pact home',exact:true}).click();await page.getByRole('button',{name:'People & trips',exact:true}).click();
  await page.locator('.member-card .person-name').filter({hasText:longName}).waitFor();
  for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});await layout(page,`members-long-name-${width}`);await accessibility(page,`members-long-name-${width}`);}
  assert.doesNotMatch(await page.locator('main').innerText(),/@example\.test/);
  await page.setViewportSize({width:390,height:844});await shot(page,'members-long-name');await done(f);
 });
 console.log('All local browser scenarios passed.');
}finally{await browser.close();await server.close();}

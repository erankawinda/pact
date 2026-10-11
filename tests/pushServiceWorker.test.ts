import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const worker=readFileSync(new URL('../public/push-sw.js',import.meta.url),'utf8');
const first='00000000-0000-4000-8000-000000000001';
const second='00000000-0000-4000-8000-000000000002';
const eventId='00000000-0000-4000-8000-000000000003';
const origin='https://pact.example.test';
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

// Exercise the shipped worker, with asynchronous IndexedDB requests/transactions.
// No delivery provider, Auth session, hosted database or browser storage is used.
function harness(){
 const handlers=new Map<string,(event:any)=>void>(),settings=new Map<string,unknown>();
 const shown:any[]=[],opened:string[]=[],navigation:string[]=[],acks:any[]=[];
 let initialized=false;
 const state={windows:[] as any[],showBarrier:null as Promise<void>|null,matchBarrier:null as Promise<void>|null,closed:0,claimed:0,skipped:0};
 const database={createObjectStore(name:string){assert.equal(name,'settings');},close(){},transaction(name:string,mode:string){
  assert.equal(name,'settings');assert.ok(['readonly','readwrite'].includes(mode));
  const tx:any={objectStore(){return {get(key:string){return request(key,false);},put(value:unknown,key:string){return request(key,true,value);}};}};
  function request(key:string,write:boolean,value?:unknown){const req:any={};queueMicrotask(()=>{if(write)settings.set(key,value);req.result=write?key:settings.get(key);req.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return req;}
  return tx;
 }};
 const self={location:{origin},addEventListener(type:string,handler:(event:any)=>void){handlers.set(type,handler);},async skipWaiting(){state.skipped++;},registration:{
  async showNotification(title:string,options:any){await state.showBarrier;const item={title,...plain(options),close(){this.closed=true;state.closed++;},closed:false};shown.push(item);},
  async getNotifications(options?:{tag?:string}){return shown.filter(item=>!item.closed&&(!options?.tag||item.tag===options.tag));}
 },clients:{async claim(){state.claimed++;},async matchAll(){await state.matchBarrier;return state.windows;},async openWindow(url:string){opened.push(url);}}};
 const context={self,indexedDB:{open(name:string,version:number){assert.equal(name,'pact-push');assert.equal(version,1);const req:any={result:database};queueMicrotask(()=>{if(!initialized){initialized=true;req.onupgradeneeded?.();}req.onsuccess?.();});return req;}},URL,console};
 runInNewContext(worker,context,{filename:'public/push-sw.js'});
 async function dispatch(type:string,props:any={}){const waits:Promise<unknown>[]=[];handlers.get(type)?.({...props,waitUntil(value:Promise<unknown>){waits.push(value);}});await Promise.all(waits);}
 const bind=(value:string|null,url=origin+'/')=>dispatch('message',{source:{url},data:{type:'PACT_NOTIFICATION_BINDING',binding:value},ports:[{postMessage(value:any){acks.push(plain(value));}}]});
 const push=(payload:any)=>dispatch('push',{data:{json(){return payload;}}});
 const click=(data:any)=>dispatch('notificationclick',{notification:{data,close(){state.closed++;}}});
 function window(url:string){return {url,async navigate(target:string){navigation.push(target);},async focus(){navigation.push('focus');}};}
 return {handlers,settings,state,shown,opened,navigation,acks,dispatch,bind,push,click,window};
}

test('push worker has no fetch handler or cache and activates without caching app data',async()=>{
 const h=harness();assert.deepEqual([...h.handlers.keys()].sort(),['activate','install','message','notificationclick','push']);
 await h.dispatch('install');await h.dispatch('activate');assert.equal(h.state.claimed,1);assert.equal(h.state.skipped,1);assert.equal(h.settings.size,0);
});
test('only same-origin binding messages persist; account clearing suppresses queued old pushes',async()=>{
 const h=harness();await h.bind(first,'https://unrelated.example/');assert.equal(h.settings.size,0);
 await h.bind(first);assert.deepEqual(h.acks,[{ok:true}]);assert.deepEqual([...h.settings.entries()],[['binding',first]]);
 await h.push({id:eventId,binding:second});assert.equal(h.shown.length,0);
 await h.bind(null);await h.push({id:eventId,binding:first});assert.equal(h.shown.length,0);
 await h.bind(second);await h.push({id:eventId,binding:first});assert.equal(h.shown.length,0);
 await h.push({id:eventId,binding:second});assert.equal(h.shown.length,1);
});
test('notification text and retained data ignore all actor, transaction and URL fields',async()=>{
 const h=harness();await h.bind(first);
 const secret={name:'Private Person',amount:12345,household:'Private Household',photo:'https://example.test/private.jpg',url:'https://evil.example/',body:'secret details',title:'secret actor'};
 await h.push({id:eventId,binding:first,category:'expense',tone:'friendly',...secret});
 const n=h.shown[0];assert.equal(n.title,'A little Pact update');assert.equal(n.body,'Your shared spending has an update. Tap to catch up.');
 assert.equal(n.tag,'pact-'+eventId);assert.equal(n.renotify,false);assert.deepEqual(n.data,{id:eventId,binding:first});
 for(const value of Object.values(secret))assert.ok(!JSON.stringify(n).includes(String(value)));
 await h.push({id:eventId,binding:first,category:'refund',tone:'brief'});assert.equal(h.shown[1].title,'Pact update');assert.equal(h.shown[1].body,'A transaction involving you changed. Open Pact to view it.');
 await h.push({id:eventId,binding:first,category:'test',tone:'brief'});assert.equal(h.shown[2].body,'You’re all set. Pact notifications work on this device.');
});
test('malformed payloads are dropped without notification or external request',async()=>{
 const h=harness();await h.bind(first);
 for(const value of [null,{},'text',{id:'https://evil.example',binding:first},{id:eventId},{id:5,binding:first}])await h.push(value);
 await h.dispatch('push',{data:{json(){throw new SyntaxError('bad JSON');}}});await h.dispatch('push');assert.equal(h.shown.length,0);
});
test('notification click focuses only a same-origin client and ignores supplied destinations',async()=>{
 const h=harness();await h.bind(first);h.state.windows=[h.window('https://evil.example/'),h.window(origin+'/account')];
 await h.click({id:eventId,binding:first,url:'https://evil.example'});assert.deepEqual(h.navigation,[origin+'/?notification='+eventId,'focus']);assert.deepEqual(h.opened,[]);
 h.state.windows=[h.window('https://evil.example/')];await h.click({id:eventId,binding:first});assert.deepEqual(h.opened,[origin+'/?notification='+eventId]);
});
test('cleared or changed binding makes old notification clicks inert',async()=>{
 const h=harness();await h.bind(first);await h.bind(null);await h.click({id:eventId,binding:first});await h.bind(second);await h.click({id:eventId,binding:first});await h.click({id:'../../outside',binding:second});assert.deepEqual(h.opened,[]);assert.deepEqual(h.navigation,[]);
});
test('clearing the binding while notification display is pending closes the late notification',async()=>{
 const h=harness(),barrier=deferred();await h.bind(first);h.state.showBarrier=barrier.promise;
 const pushing=h.push({id:eventId,binding:first});await new Promise(resolve=>setImmediate(resolve));await h.bind(null);barrier.resolve();await pushing;
 assert.equal(h.shown.filter(n=>!n.closed).length,0,'A queued alert must not remain visible after this account was cleared');
});
test('clearing the binding while client lookup is pending prevents stale navigation',async()=>{
 const h=harness(),barrier=deferred();await h.bind(first);h.state.matchBarrier=barrier.promise;
 const clicking=h.click({id:eventId,binding:first});await new Promise(resolve=>setImmediate(resolve));await h.bind(null);barrier.resolve();await clicking;
 assert.deepEqual(h.opened,[]);assert.deepEqual(h.navigation,[]);
});

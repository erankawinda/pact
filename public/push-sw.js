/* Push only: no fetch handler, offline cache, financial records or Auth tokens. */
const DB_NAME = 'pact-push';
function database() {
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DB_NAME,1);
  request.onupgradeneeded=()=>request.result.createObjectStore('settings');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
}
async function binding(value,write=false) {
 const db=await database();
 try {return await new Promise((resolve,reject)=>{
  const tx=db.transaction('settings',write?'readwrite':'readonly'),store=tx.objectStore('settings');
  const req=write?store.put(value,'binding'):store.get('binding');
  let result;req.onsuccess=()=>{result=req.result;};
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 });} finally {db.close();}
}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
 if(event.data?.type!=='PACT_NOTIFICATION_BINDING')return;
 // Only a same-origin window can change this installation's binding.
 if(!event.source?.url || new URL(event.source.url).origin!==self.location.origin)return;
 const value=event.data.binding;
 if(value!==null && (typeof value!=='string'||!/^[-0-9a-f]{36}$/i.test(value)))return;
 event.waitUntil(binding(value,true).then(()=>event.ports[0]?.postMessage({ok:true})).catch(()=>event.ports[0]?.postMessage({ok:false})));
});
self.addEventListener('push',event=>{
 event.waitUntil((async()=>{
  let payload;try{payload=event.data?.json();}catch{return;}
  if(!payload || typeof payload.id!=='string'||!/^[-0-9a-f]{36}$/i.test(payload.id)||typeof payload.binding!=='string')return;
  const current=await binding();
  // A removed/account-switched installation must never display an old account's alert.
  if(!current || payload.binding!==current)return;
  const friendly=payload.tone!=='brief',test=payload.category==='test';
  await self.registration.showNotification(friendly?'A little Pact update':'Pact update',{
   body:test?'You’re all set. Pact notifications work on this device.':friendly?'Your shared spending has an update. Tap to catch up.':'A transaction involving you changed. Open Pact to view it.',
   icon:'/icons/pact-192.png',badge:'/icons/pact-192.png',tag:'pact-'+payload.id,renotify:false,
   data:{id:payload.id,binding:current}
  });
  // The account can change while the OS is displaying the notification. Remove late delivery too.
  if (await binding()!==current) {
   const shown=await self.registration.getNotifications({tag:'pact-'+payload.id});
   shown.forEach(notification=>notification.close());
  }
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const data=event.notification.data,current=await binding();
  if(!current || data?.binding!==current || typeof data?.id!=='string'||!/^[-0-9a-f]{36}$/i.test(data.id))return;
  const url=new URL('/?notification='+encodeURIComponent(data.id),self.location.origin).href;
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(await binding()!==current)return;
  const existing=windows.find(client=>new URL(client.url).origin===self.location.origin);
  if(existing){await existing.navigate(url);await existing.focus();}else await self.clients.openWindow(url);
 })());
});

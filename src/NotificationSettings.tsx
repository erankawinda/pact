import {useEffect,useState} from 'react';
import {Alert,Loading} from './ui';
import {message} from './errors';
import {DEFAULT_NOTIFICATION_PREFERENCES,disableDeviceNotifications,enableDeviceNotifications,loadNotificationPreferences,notificationDeviceEnabled,notificationSupport,notificationsConfigured,saveNotificationPreferences,sendTestNotification,type NotificationPreferences} from './notifications';

function notificationError(error:unknown):string {
 const text=String((error as {message?:string})?.message??'');
 if (/push_device_conflict|push_endpoint_conflict|invalid_push_subscription/.test(text)) return 'This device’s notification setup needs a fresh start. Reset device setup, then enable notifications again.';
 if (/push_device_limit/.test(text)) return 'You have reached the limit of 10 enabled devices. Turn off notifications on an older device first.';
 if (/push_not_enabled/.test(text)) return 'Enable notifications on this device before sending a test.';
 if (/push_test_rate_limit/.test(text)) return 'Wait one minute before sending another test notification.';
 if (/invalid_notification_preferences/.test(text)) return 'Choose your notification categories and tone, then save again.';
 return message(error);
}

export function NotificationSettings({userId,online}:{userId:string;online:boolean}) {
 const [preferences,setPreferences]=useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
 const [saved,setSaved]=useState<NotificationPreferences|null>(null),[enabled,setEnabled]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0);
 const support=notificationSupport();
 useEffect(()=>{
  let active=true;
  if (!notificationsConfigured) {setLoading(false);return;}
  setLoading(true);setError('');
  void Promise.all([loadNotificationPreferences(),support==='supported'?notificationDeviceEnabled(userId):Promise.resolve(false)]).then(([value,on])=>{if(active){setPreferences(value);setSaved(value);setEnabled(on);}}).catch(e=>{if(active)setError(notificationError(e));}).finally(()=>{if(active)setLoading(false);});
  return ()=>{active=false;};
 },[userId,attempt,support]);
 async function run(action:()=>Promise<void>) {
  if(busy)return;setBusy(true);setError('');setNotice('');
  try {await action();} catch(e){setError(notificationError(e));} finally {setBusy(false);}
 }
 const changed=saved!==null&&JSON.stringify(saved)!==JSON.stringify(preferences);
 return <section className="card account-section" aria-labelledby="notifications-heading">
  <h2 id="notifications-heading">Phone notifications</h2>
  <p className="helper">A quiet update when a transaction involves you. Your own changes, shopping and other people’s transactions do not send alerts.</p>
  {!notificationsConfigured?<p className="callout">Phone notifications are being prepared. Your transactions still update normally in Pact.</p>:<>
   {support==='install'&&<p className="callout">On iPhone or iPad, add Pact to your Home Screen, open it from its icon, then enable notifications here. Requires iOS or iPadOS 16.4 or later.</p>}
   {support==='unsupported'&&<p className="callout">This browser cannot receive Pact notifications. Try an updated browser or open Pact from your Home Screen.</p>}
   {loading?<Loading text="Loading notification settings…"/>:<>
    <p className="helper" role="status">{enabled?'On for this device':'Off for this device'}{support==='supported'&&Notification.permission==='denied'?' · Blocked in browser or phone settings':''}</p>
    {support==='supported'&&<div className="inline-actions"><button className="primary" disabled={busy||!online||saved===null} onClick={()=>void run(async()=>{if(enabled){await disableDeviceNotifications();setEnabled(false);setNotice('Notifications turned off for this device.');}else{await enableDeviceNotifications(userId);setEnabled(true);setNotice('Notifications enabled for this device.');}})}>{enabled?'Turn off on this device':'Enable on this device'}</button>{enabled&&<button disabled={busy||!online} onClick={()=>void run(async()=>{await sendTestNotification(userId);setNotice('Test queued. It should arrive shortly; phone Focus settings can delay it.');})}>Send a test notification</button>}</div>}
    {saved!==null&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{const value=await saveNotificationPreferences(preferences);setPreferences(value);setSaved(value);setNotice('Notification preferences saved for your devices.');});}}>
     <fieldset disabled={busy||!online}><legend>Updates you want</legend>
      <label className="check-row"><input type="checkbox" checked={preferences.expenses} onChange={event=>setPreferences({...preferences,expenses:event.target.checked})}/>Expenses and corrections</label>
      <label className="check-row"><input type="checkbox" checked={preferences.refunds} onChange={event=>setPreferences({...preferences,refunds:event.target.checked})}/>Refunds</label>
      <label className="check-row"><input type="checkbox" checked={preferences.repayments} onChange={event=>setPreferences({...preferences,repayments:event.target.checked})}/>Repayments and confirmations</label>
     </fieldset>
     <label>Notification tone<select disabled={busy||!online} value={preferences.tone} onChange={event=>setPreferences({...preferences,tone:event.target.value as NotificationPreferences['tone']})}><option value="friendly">Friendly</option><option value="brief">Brief</option></select></label>
     <div className="quiet-card"><strong>{preferences.tone==='friendly'?'A little Pact update':'Pact update'}</strong><p className="helper">{preferences.tone==='friendly'?'Your shared spending has an update. Tap to catch up.':'A transaction involving you changed. Open Pact to view it.'}</p></div>
     <p className="helper">Names, amounts, household names and photos stay out of notifications. These categories and tone apply to all your enabled devices.</p>
     <button className="primary" disabled={busy||!online||!changed}>{busy?'Saving…':'Save notification preferences'}</button>
    </form>}
   </>}
  </>}
  <Alert text={error}>{support==='supported'&&<button disabled={busy} onClick={()=>void run(async()=>{await disableDeviceNotifications();setEnabled(false);setNotice('Device setup cleared. You can enable notifications again.');setAttempt(value=>value+1);})}>Reset device setup</button>}{saved===null&&notificationsConfigured&&<button disabled={busy||!online} onClick={()=>setAttempt(value=>value+1)}>Try loading notifications again</button>}</Alert>
  {notice&&<p className="notice" role="status">{notice}</p>}
 </section>;
}

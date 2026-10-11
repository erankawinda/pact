import {client, rpc} from './api';

export type NotificationPreferences = {expenses:boolean; refunds:boolean; repayments:boolean; tone:'friendly'|'brief'};
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {expenses:true,refunds:true,repayments:true,tone:'friendly'};
export const notificationsConfigured = import.meta.env.VITE_NOTIFICATIONS_ENABLED === 'true' && Boolean(import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY);
const DEVICE_KEY = 'pact:push-device';
type Device = {userId:string; id:string; binding:string};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let account: string|null = null;
let accountEpoch=0;
let cleanup: Promise<void> = Promise.resolve();

export function notificationSupport(): 'supported'|'install'|'unsupported' {
  if (!window.isSecureContext) return 'unsupported';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !matchMedia('(display-mode: standalone)').matches && !(navigator as Navigator & {standalone?:boolean}).standalone) return 'install';
  return ('serviceWorker' in navigator) && ('Notification' in window) && ('PushManager' in window) ? 'supported' : 'unsupported';
}
function readDevice(): Device|null {
  const raw = localStorage.getItem(DEVICE_KEY);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Notification setup could not be read. Reset notifications on this device.');
  const data = value as Device;
  if (![data.userId,data.id,data.binding].every(value=>typeof value === 'string' && uuid.test(value))) throw new Error('Notification setup could not be read. Reset notifications on this device.');
  return data;
}
function writeDevice(value: Device) {
  const raw = JSON.stringify(value);
  localStorage.setItem(DEVICE_KEY,raw);
  if (localStorage.getItem(DEVICE_KEY)!==raw) throw new Error('Allow site storage before enabling notifications.');
}
async function registration(create=false): Promise<ServiceWorkerRegistration|undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const current = await navigator.serviceWorker.getRegistration('/');
  if (current || !create) return current;
  await navigator.serviceWorker.register('/push-sw.js',{scope:'/',updateViaCache:'none'});
  return navigator.serviceWorker.ready;
}
async function setWorkerBinding(reg: ServiceWorkerRegistration|undefined,binding:string|null) {
  if (!reg) return;
  const worker = reg.active;
  if (!worker) throw new Error('Notifications are still starting. Please try again.');
  await new Promise<void>((resolve,reject)=>{
    const channel = new MessageChannel();
    const timer = setTimeout(()=>{channel.port1.close();reject(new Error('Notification storage did not respond. Please try again.'));},5000);
    channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.ok?resolve():reject(new Error('Notification storage is unavailable on this device.'));};
    worker.postMessage({type:'PACT_NOTIFICATION_BINDING',binding},[channel.port2]);
  });
}
async function disableNow() {
  const reg = await registration();
  // Clear the worker binding first: a queued old-account message must not show after a switch.
  let bindingError: unknown;
  try {await setWorkerBinding(reg,null);} catch(error) {bindingError=error;}
  const subscription = await reg?.pushManager.getSubscription();
  if (subscription && !await subscription.unsubscribe()) throw new Error('Could not disconnect this device from notifications. Try again before switching accounts.');
  // Even a successful unsubscribe cannot retract an already queued push. The local binding must clear.
  if (bindingError) throw bindingError;
  const visible = await reg?.getNotifications();
  visible?.forEach(notification=>notification.close());
  let device: Device|null = null;
  try {device=readDevice();} catch {/* Reset a malformed device record after browser delivery is disconnected. */}
  if (device && client) {
    try {await rpc('revoke_push_subscription',{p_device:device.id});}
    catch {/* The unsubscribed endpoint no longer receives; the worker also checks session validity. */}
  }
  try {localStorage.removeItem(DEVICE_KEY);} catch {/* Delivery is disconnected even if site storage is unavailable. */}
}
/** Invoke before signing out or opening an account switch. A local unsubscribe failure must remain visible. */
export async function disableDeviceNotifications(): Promise<void> {
  cleanup = cleanup.catch(()=>{}).then(disableNow);
  return cleanup;
}
/** Call only after Auth has resolved a real session, not during the initial unknown/loading state. */
export async function prepareNotificationAccount(userId:string|null): Promise<void> {
  if (account!==userId) accountEpoch++;
  account=userId;
  await cleanup;
  let device: Device|null;
  try {device=readDevice();} catch {await disableDeviceNotifications();return;}
  if (device && device.userId!==userId) await disableDeviceNotifications();
}
export async function notificationDeviceEnabled(userId:string): Promise<boolean> {
  await cleanup;
  const device=readDevice();
  if (!device || device.userId!==userId || Notification.permission!=='granted') return false;
  const sub=await (await registration())?.pushManager.getSubscription();
  if (!sub) return false;
  const result=await rpc<{enabled:boolean}>('get_push_subscription',{p_device:device.id});
  return result.enabled===true;
}
function applicationKey(value:string): Uint8Array<ArrayBuffer> {
  const base64=value.replace(/-/g,'+').replace(/_/g,'/');
  const binary=atob(base64+'='.repeat((4-base64.length%4)%4));
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
/** Must be called directly from the Enable button so the browser permission prompt has user activation. */
export async function enableDeviceNotifications(userId:string): Promise<void> {
  if (!notificationsConfigured) throw new Error('Notifications are not connected yet.');
  if (notificationSupport()!=='supported') throw new Error('Open Pact from your Home Screen in a supported browser to enable notifications.');
  const epoch=accountEpoch;
  if (account!==userId) throw new Error('Your account is still loading. Reopen notification settings.');
  const current=()=>account===userId&&accountEpoch===epoch;
  // Request permission before any network or service-worker await loses the user gesture.
  const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
  if (permission!=='granted') throw new Error(permission==='denied'?'Notifications are blocked. Allow them in your browser or phone settings, then try again.':'Notifications were not enabled. You can try again whenever you like.');
  if (!current()) throw new Error('Your account changed. Reopen notification settings.');
  if (!client || (await client.auth.getSession()).data.session?.user.id!==userId) throw new Error('Your account changed. Reopen notification settings.');
  await cleanup;
  if (!current()) throw new Error('Your account changed. Reopen notification settings.');
  const reg=await registration(true);
  if (!reg) throw new Error('This browser does not support notifications.');
  if (!current()) throw new Error('Your account changed. Reopen notification settings.');
  let device=readDevice();
  if (!device) {device={userId,id:crypto.randomUUID(),binding:crypto.randomUUID()};writeDevice(device);}
  let subscription=await reg.pushManager.getSubscription();
  if (!subscription) subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY)});
  if (!current()) {await disableDeviceNotifications();throw new Error('Your account changed. Reopen notification settings.');}
  const json=subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('The browser returned an incomplete notification subscription.');
  // Persist the binding before registration. A lost HTTP response can be safely retried with the same device.
  await setWorkerBinding(reg,device.binding);
  if (!current() || (await client.auth.getSession()).data.session?.user.id!==userId) {await disableDeviceNotifications();throw new Error('Your account changed. Enable notifications again for this account.');}
  await rpc('register_push_subscription',{p_device:device.id,p_endpoint:json.endpoint,p_p256dh:json.keys.p256dh,p_auth:json.keys.auth,p_binding:device.binding});
  if (!current()) {await disableDeviceNotifications();throw new Error('Your account changed. Enable notifications again for this account.');}
}
export async function sendTestNotification(userId:string): Promise<void> {
  const device=readDevice();
  if (!device || device.userId!==userId) throw new Error('Enable notifications on this device first.');
  await rpc('send_test_notification',{p_device:device.id});
}
export async function loadNotificationPreferences(): Promise<NotificationPreferences> {
  const result=await rpc<NotificationPreferences>('get_notification_preferences',{});
  if (![result.expenses,result.refunds,result.repayments].every(value=>typeof value==='boolean') || !['friendly','brief'].includes(result.tone)) throw new Error('Notification preferences could not be loaded.');
  return result;
}
export async function saveNotificationPreferences(value:NotificationPreferences): Promise<NotificationPreferences> {
  return rpc('set_notification_preferences',{p_expenses:value.expenses,p_refunds:value.refunds,p_repayments:value.repayments,p_tone:value.tone});
}
export async function resolveNotificationNavigation(): Promise<{screen:'expenses'|'balances'|'account';group:string}|null> {
  const url=new URL(location.href),id=url.searchParams.get('notification');
  if (!id) return null;
  if (!uuid.test(id)) {url.searchParams.delete('notification');history.replaceState(history.state,'',url);return null;}
  const result=await rpc<{screen:string;household:string|null}>('resolve_notification',{p_id:id});
  url.searchParams.delete('notification');history.replaceState(history.state,'',url);
  if (!['expenses','balances','account'].includes(result.screen) || (result.household!==null&&!uuid.test(result.household))) throw new Error('This notification is no longer available.');
  return {screen:result.screen as 'expenses'|'balances'|'account',group:result.household??''};
}

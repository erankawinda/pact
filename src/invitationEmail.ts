import {FunctionsHttpError} from '@supabase/supabase-js';
import {client,rpc} from './api';

export const invitationEmailEnabled=import.meta.env.VITE_INVITATION_EMAIL_ENABLED==='true';
export type InvitationEmailStatus='not_sent'|'sending'|'sent'|'failed'|'unknown'|'unavailable';
export type InvitationEmailResult={
  status:InvitationEmailStatus;
  invitation_id?:string;
  sent_at?:string;
  retry_at?:string;
  retry_until?:string;
  can_retry:boolean;
  error_code?:string;
};
export type InvitationEmailReceipt=InvitationEmailResult&{invitation_id:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses:InvitationEmailStatus[]=['not_sent','sending','sent','failed','unknown','unavailable'];
const errorMessages:Record<string,string>={
  invitation_email_unavailable:'Email sending is not connected right now. You can still share the personal link below.',
  unauthenticated:'Sign in again before sending this invitation.',
  forbidden:'This invitation is no longer available, or you do not have permission to send it. Return to People and check your access.',
  invalid_invitation:'This invitation has expired, was replaced or is no longer available. Return to People to create a new one.',
  invalid_request:'This invitation could not be sent. Return to People to create a new one.',
  rate_limited:'Please wait before trying again. You can still share the existing link.',
  retry_window_expired:'The safe retry period has ended. Share the existing link or create a replacement invitation.',
  attempts_exhausted:'The email retry limit has been reached. Share the existing link or create a replacement invitation.',
  provider_rejected:'The email service did not accept this invitation. Share the existing link or create a replacement invitation.',
  provider_rate_limit:'The email service is busy. Check the status after the retry time before trying again.',
  provider_unavailable:'The email service is unavailable. Check the status before trying again, or share the existing link.',
  provider_timeout:'The email service did not confirm the send. Check the status before trying again.',
  delivery_unconfirmed:'The email service did not confirm the send. Check the status before trying again.',
  invalid_metadata:'The invitation could not be emailed. You can still share its personal link.',
};
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:undefined;
function record(value:unknown):Record<string,unknown>|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function normalized(value:unknown):InvitationEmailResult|null{
  const item=record(value);
  if(!item||!statuses.includes(item.status as InvitationEmailStatus))return null;
  const invitation_id=typeof item.invitation_id==='string'&&uuid.test(item.invitation_id)?item.invitation_id:undefined;
  if(item.status!=='unavailable'&&!invitation_id)return null;
  const unavailable=item.status==='unavailable';
  return {status:item.status as InvitationEmailStatus,invitation_id,sent_at:date(item.sent_at),retry_at:date(item.retry_at),retry_until:date(item.retry_until),can_retry:unavailable||(item.status==='unknown'&&item.can_retry===true),error_code:unavailable?'invitation_email_unavailable':typeof item.error_code==='string'&&Object.hasOwn(errorMessages,item.error_code)?item.error_code:undefined};
}
function uncertain():InvitationEmailResult{return {status:'unknown',can_retry:false};}

/** The token exists only in this request and the current form's memory. Never log or persist it. */
export async function sendInvitationEmail(groupId:string,token:string):Promise<InvitationEmailResult>{
  if(!invitationEmailEnabled||!client)return {status:'unavailable',can_retry:true,error_code:'invitation_email_unavailable'};
  if(!uuid.test(groupId)||!/^([0-9a-f]{64})$/.test(token))return {status:'failed',can_retry:false,error_code:'invalid_invitation'};
  try{
    const {data,error}=await client.functions.invoke('invitation-email',{body:{group_id:groupId,token}});
    if(!error)return normalized(data)??uncertain();
    if(error instanceof FunctionsHttpError){
      const body=record(await error.context.json().catch(()=>null));
      const status=error.context.status;
      const code=status===401?'unauthenticated':status===403?'forbidden':status===400?'invalid_invitation':status===413?'invalid_request':undefined;
      if(status===503&&body?.error==='invitation_email_unavailable')return {status:'unavailable',can_retry:true,error_code:'invitation_email_unavailable'};
      if(status===429&&body?.error==='invitation_email_rate_limit')return {status:'unavailable',can_retry:true,error_code:'rate_limited'};
      if(code)return {status:'failed',can_retry:false,error_code:code};
      const parsed=normalized(body);
      if(parsed)return parsed;
    }
    // A missing response is not proof that no email was sent. A retry keeps the
    // same token so the server can reconcile the existing send instead of duplicating it.
    return uncertain();
  }catch{return uncertain();}
}

export async function loadInvitationEmailStatus(groupId:string,token?:string):Promise<InvitationEmailReceipt[]>{
  if(!invitationEmailEnabled)throw new Error('Email status is not available in this version.');
  if(token&&!/^[0-9a-f]{64}$/.test(token))throw new Error('This invitation is no longer available.');
  const hash=token?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join(''):undefined;
  const data=await rpc<unknown>('get_invitation_email_status',{p_group:groupId,...(hash?{p_token_hash:hash}:{})});
  if(!Array.isArray(data))throw new Error('Email status could not be loaded.');
  return data.map(item=>{
    const result=normalized(item);
    if(!result?.invitation_id||result.status==='unavailable')throw new Error('Email status could not be loaded.');
    return result as InvitationEmailReceipt;
  });
}

export function invitationEmailLabel(status:InvitationEmailStatus):string{
  return {not_sent:'Email not sent',sending:'Sending email…',sent:'Email sent',failed:'Could not send email',unknown:'Send status unconfirmed',unavailable:'Email sending unavailable'}[status];
}
export function invitationEmailMessage(result:InvitationEmailResult):string{
  if(result.status==='sent')return 'The email service accepted the invitation. Inbox delivery is not confirmed; they can check Spam if it does not appear.';
  if(result.status==='sending')return 'Pact is checking this email request. Keep this page open to check its status, or share the same link below.';
  if(result.status==='unknown')return 'We could not confirm whether the email was sent. Check its status before creating another invitation. A retry uses the same invitation to avoid a duplicate send.';
  if(result.status==='not_sent')return 'No email send is recorded for this invitation. You can share the link below.';
  return (result.error_code&&errorMessages[result.error_code])||'The email could not be sent. You can still share the personal link below.';
}

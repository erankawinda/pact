import {useRef,useState,type FormEvent} from 'react';
import {rpc,type Group} from './api';
import {definitelyRejected,message} from './errors';
import {invitationEmailEnabled,invitationEmailLabel,invitationEmailMessage,loadInvitationEmailStatus,sendInvitationEmail,type InvitationEmailResult} from './invitationEmail';
import {newInvitationToken} from './participants';
import {Alert,FormHeader,Icon,moveToTop} from './ui';

type Inclusion={participant_id:string;invitation_id:string;token:string;expires_at:string};
type Request={p_group:string;p_name:string;p_email:string;p_request:string;p_token:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function IncludePersonForm({group,online,onBack,onIncluded}: {group:Group;online:boolean;onBack:()=>void;onIncluded:(participantId:string)=>Promise<void>}){
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[sendEmail,setSendEmail]=useState(invitationEmailEnabled);
 const [included,setIncluded]=useState<Inclusion|null>(null),[delivery,setDelivery]=useState<InvitationEmailResult|null>(null);
 const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[uncertain,setUncertain]=useState(false),[copied,setCopied]=useState(false),[error,setError]=useState('');
 const request=useRef<Request|null>(null),flight=useRef(false);
 const locked=busy||checking;
 const link=included?`${location.origin}/#invite=${included.token}`:'';
 async function submit(event:FormEvent){
  event.preventDefault();if(flight.current||!online)return;
  if(!request.current)request.current={p_group:group.id,p_name:name.trim(),p_email:email.trim().toLowerCase(),p_request:crypto.randomUUID(),p_token:newInvitationToken()};
  const input=request.current;flight.current=true;setBusy(true);setError('');
  try{
   const value=await rpc<Inclusion>('add_pending_participant',input);
   if(!value||!uuid.test(value.participant_id)||!uuid.test(value.invitation_id)||value.token!==input.p_token||!Number.isFinite(Date.parse(value.expires_at)))throw new Error('Inclusion could not be confirmed.');
   setIncluded(value);setUncertain(false);moveToTop();
   if(sendEmail){setDelivery({status:'sending',can_retry:false});setDelivery(await sendInvitationEmail(group.id,value.token));}
  }catch(error){
   if(definitelyRejected(error)){request.current=null;setUncertain(false);setError(message(error));}
   else{setUncertain(true);setError('We could not confirm their place yet. Keep this page open and check the same request. Pact will not create a second person.');}
  }finally{flight.current=false;setBusy(false);}
 }
 async function retryEmail(){
  if(flight.current||!online||!included)return;flight.current=true;setBusy(true);setError('');setDelivery({status:'sending',can_retry:false});
  try{setDelivery(await sendInvitationEmail(group.id,included.token));}finally{flight.current=false;setBusy(false);}
 }
 async function checkEmail(){
  if(flight.current||!online||!included)return;flight.current=true;setChecking(true);setError('');
  try{const rows=await loadInvitationEmailStatus(group.id,included.token);setDelivery(rows[0]??{status:'failed',can_retry:false,error_code:'invalid_invitation'});}
  catch{setError('Email status could not be checked. This does not tell us whether it was sent. Try again or share the existing link.');}
  finally{flight.current=false;setChecking(false);}
 }
 async function copy(){try{await navigator.clipboard.writeText(link);setCopied(true);setError('');}catch{setError('Select and copy the invitation link below.');}}
 async function share(){try{await navigator.share({title:`Your place in ${group.name} is ready`,text:`You are included in ${group.name} on Pact. Sign in with your invited Google account to review your share and join.`,url:link});}catch(error){if((error as Error).name!=='AbortError')setError('Sharing did not open. Use Copy link instead.');}}
 async function finish(){if(flight.current||!included)return;flight.current=true;setBusy(true);setError('');try{await onIncluded(included.participant_id);}catch{setError('Their place is ready, but the people list did not refresh. Try continuing again.');}finally{flight.current=false;setBusy(false);}}
 const retryAllowed=delivery&&(delivery.can_retry||delivery.status==='not_sent'||delivery.status==='unavailable')&&(!delivery.retry_until||Date.parse(delivery.retry_until)>Date.now());
 return <section className="form-page include-person-page">
  <FormHeader title={included?'Their place is ready':'Include someone'} context={group.name} onBack={onBack} disabled={locked}/>
  {included?<>
   <div className="review-card"><p className="eyebrow">Included now. Ready when they are.</p><h2 className="break-word">{request.current?.p_name}</h2><p className="muted">You can include them as the payer or in a split now. Their invitation connects these records to their own account when they join.</p></div>
   <p className="helper">Only <strong className="break-word">{request.current?.p_email}</strong> can accept this invitation. They will see a summary of records added for them before joining.</p>
   {delivery?<section className="card" aria-label="Invitation email status"><div role="status" aria-live="polite"><h2>{invitationEmailLabel(delivery.status)}</h2><p className="helper">{invitationEmailMessage(delivery)}</p></div>{delivery.retry_at&&delivery.status!=='sent'&&<p className="helper">Next status check: {new Date(delivery.retry_at).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'})}.</p>}<div className="inline-actions">{(delivery.status==='sending'||delivery.status==='unknown')&&<button disabled={locked||!online} onClick={()=>void checkEmail()}>{checking?'Checking…':'Check email status'}</button>}{retryAllowed&&<button disabled={locked||!online} onClick={()=>void retryEmail()}>{delivery.status==='not_sent'?'Send invitation email':'Retry email'}</button>}</div></section>:<p className="callout">Share their personal link to let them know. No email has been sent.</p>}
   <div className="share-actions"><button disabled={locked} onClick={()=>void copy()}>{copied&&<Icon name="check"/>}{copied?'Copied':'Copy link'}</button>{typeof navigator.share==='function'&&<button disabled={locked} onClick={()=>void share()}>Share…</button>}</div>
   <p className="helper" role="status">{copied&&'Link copied. Paste it into your message. '}Invitation expires {new Date(included.expires_at).toLocaleDateString('en-AU')}. If it expires or is revoked, their records stay, but new expenses cannot include them until a new invitation is ready.</p>
   <details className="optional-fields"><summary>Personal invitation link</summary><label>Invitation link<input readOnly value={link} onFocus={event=>event.target.select()}/></label></details>
   <Alert text={error}/><button className="primary full" disabled={locked} onClick={()=>void finish()}>{busy?'Opening…':'Continue with this person'}</button>
  </>:<form onSubmit={submit}>
   <p className="eyebrow">No one left out</p><p className="intro muted">Add their share now. Their place is waiting when they join.</p>
   <p className="callout">This includes them only in <strong className="break-word">{group.name}</strong>. They cannot access it until they accept their invitation.</p>
   <label>Their name<input required maxLength={80} autoComplete="off" value={name} disabled={locked||uncertain} onChange={event=>setName(event.target.value)} placeholder="What do you call them?"/></label>
   <label>Google email<input required maxLength={254} type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} disabled={locked||uncertain} onChange={event=>setEmail(event.target.value)} placeholder="Their Google account email"/></label>
   <p className="helper">Use the Google account they will join with. Their own name and photo appear after joining; earlier amounts and who recorded them stay unchanged.</p>
   {invitationEmailEnabled&&<label className="check-row"><input type="checkbox" checked={sendEmail} disabled={locked||uncertain} onChange={event=>setSendEmail(event.target.checked)}/>Email their invitation</label>}
   <Alert text={error}/><button className="primary full" disabled={locked||!online}>{busy?uncertain?'Checking…':'Making room…':uncertain?'Check inclusion':sendEmail?'Include & invite':'Include & create link'}</button>
   <p className="helper">They review their recorded amounts before joining. Joining does not approve those amounts. Repayments wait until they have joined.</p>
  </form>}
 </section>;
}

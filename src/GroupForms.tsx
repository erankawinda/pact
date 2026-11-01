import {useEffect,useRef,useState,type FormEvent} from 'react';
import {reauthenticate,rpc,type Group,type Member,type Snapshot} from './api';
import {message} from './errors';
import {money} from './money';
import {clearInvite,invitationToken,rememberInvite} from './invitations';
import {invitationEmailEnabled,invitationEmailLabel,invitationEmailMessage,loadInvitationEmailStatus,sendInvitationEmail,type InvitationEmailResult} from './invitationEmail';
import {useMutation} from './useMutation';
import {Recovery} from './actions';
import {Alert,FormHeader,Icon,Loading,moveToTop} from './ui';
type FormProps={onBack:()=>void;online:boolean};
export function GroupForm({kind,groups,initialParent,onBack,online,onCreated,userId}:FormProps&{kind:'household'|'trip';groups:Group[];initialParent?:string;onCreated:(id:string)=>Promise<boolean>;userId:string}) {
 const households=groups.filter(g=>g.kind==='household'&&!g.archived_at);
 const [name,setName]=useState(''),[parent,setParent]=useState(households.find(g=>g.id===initialParent)?.id??households[0]?.id??'');
 const [people,setPeople]=useState<string[]>([]),[members,setMembers]=useState<Member[]|null>(null),[error,setError]=useState('');
 const mutation=useMutation(userId,`create-${kind}`,async id=>{if(!await onCreated(String(id)))throw new Error('Load failed');});
 const locked=mutation.busy||!!mutation.pending;
 useEffect(()=>{if(kind!=='trip'||!parent)return;let active=true;setMembers(null);setError('');void rpc<Snapshot>('get_group_state_v4',{p_group:parent,p_limit:1}).then(s=>{if(active){setMembers(s.members.filter(m=>m.status==='active'&&m.auth_user_id!==null));setPeople([]);}}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[parent,kind]);
 async function submit(event:FormEvent){event.preventDefault();if(locked||!online)return;await mutation.run('create_space',{p_name:name.trim(),p_kind:kind,p_parent:kind==='trip'?parent:null,p_people:kind==='trip'?people:[]},`Create ${kind}`);}
 return <section className="form-page"><FormHeader title={kind==='trip'?'Create a trip':'Create your household'} context="Pact" onBack={onBack} disabled={mutation.busy}/><p className="muted">{kind==='trip'?'Choose who is going. Trip costs stay separate from household costs.':'One shared place for your flatmates, expenses and shopping.'}</p><Recovery mutation={mutation} online={online}/><form onSubmit={submit}><label>{kind==='trip'?'Trip name':'Household name'}<input required maxLength={80} value={name} disabled={locked} onChange={e=>setName(e.target.value)} placeholder={kind==='trip'?'Weekend away':'Our home'}/></label>{kind==='trip'&&<><label>Household<select required value={parent} disabled={locked} onChange={e=>setParent(e.target.value)}>{households.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label><fieldset><legend>Who is going?</legend><p className="helper">Choose household members now. You are included as the trip organiser. You can invite other friends after creating the trip.</p>{!members&&!error?<Loading text="Loading people…"/>:<div className="list-panel">{members?.filter(m=>m.auth_user_id!==userId).map(m=><label className="check-row" key={m.id}><input type="checkbox" disabled={locked} checked={people.includes(m.auth_user_id!)} onChange={e=>setPeople(old=>e.target.checked?[...old,m.auth_user_id!]:old.filter(id=>id!==m.auth_user_id))}/>{m.name}</label>)}</div>}</fieldset></>}<Alert text={error}/><button className="primary full" disabled={locked||!online||(kind==='trip'&&(!parent||!members))}>{mutation.busy?'Creating…':`Create ${kind}`}</button>{kind==='household'&&<p className="helper">Invite your flatmates on the next screen.</p>}</form></section>;
}
type InvitationPreview={group_id:string;group_name:string;group_kind:'household'|'trip';participant_id:string|null;invited_name:string|null;expense_count:number;paid_cents:number;share_cents:number;net_cents:number;review_digest:string;already_joined:boolean};
export function JoinForm({initialToken,email,onBack,online,onJoined}:FormProps&{initialToken:string;email:string;onJoined:(id:string)=>Promise<boolean>}) {
 const [value,setValue]=useState(initialToken),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [preview,setPreview]=useState<InvitationPreview|null>(null),[reviewed,setReviewed]=useState(false);
 const joined=useRef(''),flight=useRef(false),reviewedToken=useRef('');
 async function loadPreview(token:string){
  const result=await rpc<InvitationPreview>('get_invitation_preview',{p_token:token});
  if(!result||typeof result.group_id!=='string'||typeof result.group_name!=='string'||!['household','trip'].includes(result.group_kind)||typeof result.review_digest!=='string'||![result.expense_count,result.paid_cents,result.share_cents,result.net_cents].every(Number.isSafeInteger)||result.expense_count<0||result.paid_cents<0||result.share_cents<0||typeof result.already_joined!=='boolean')throw new Error('Your invitation summary could not be loaded. Please try again.');
  reviewedToken.current=token;setPreview(result);setReviewed(false);
 }
 async function reviewInvitation(token:string){
  if(flight.current||!online)return;flight.current=true;setBusy(true);setError('');setNotice('');setPreview(null);setReviewed(false);
  try{rememberInvite(token);await loadPreview(token);}catch(error){setError(message(error));}finally{flight.current=false;setBusy(false);}
 }
 useEffect(()=>{const token=invitationToken(initialToken);if(token)void reviewInvitation(token);},[]);
 async function submit(event:FormEvent){
  event.preventDefault();if(flight.current||!online)return;
  const token=invitationToken(value);if(!token){setError('Paste the complete invitation link or its 64-character code.');return;}
  if(!preview||reviewedToken.current!==token){await reviewInvitation(token);return;}
  if(preview.expense_count>0&&!preview.already_joined&&!reviewed){setError('Read the recorded amounts and confirm you understand before joining.');return;}
  rememberInvite(token);flight.current=true;setBusy(true);setError('');setNotice('');
  try{
   if(!joined.current)joined.current=preview.already_joined?preview.group_id:await rpc<string>('accept_invitation_v2',{p_token:token,p_review_digest:preview.review_digest});
   if(await onJoined(joined.current))clearInvite();else setError('You have joined. Try opening the household or trip again.');
  }catch(error){
   const detail=error&&typeof error==='object'&&'message' in error?String(error.message):'';
   if(detail.includes('invitation_preview_changed')){
    setPreview(null);setReviewed(false);
    try{await loadPreview(token);setNotice('The records changed while you were reviewing. Check the updated summary before joining.');}catch(refreshError){setError(message(refreshError));}
   }else setError(message(error));
  }finally{flight.current=false;setBusy(false);}
 }
 async function switchAccount(){setError('');try{if(value&&!rememberInvite(value))throw new Error('Paste a valid invitation before switching accounts.');await reauthenticate();}catch(error){setError(message(error));}}
 return <section className="form-page join-preview-page">
  <FormHeader title={preview?'Your place is ready':'Join your people'} context="Pact" onBack={onBack} disabled={busy}/>
  <p className="muted">Joining as <strong className="break-word">{email}</strong>.</p><button className="text-button" disabled={busy||!online} onClick={()=>void switchAccount()}>Use a different Google account</button>
  {busy&&!preview?<Loading text="Preparing your invitation…"/>:null}
  <form onSubmit={submit}>
   {!preview&&<><label>Invitation link or code<input required value={value} disabled={busy||!!joined.current} onChange={event=>{setValue(event.target.value);setPreview(null);setReviewed(false);}} placeholder="Paste your invitation" autoComplete="off" autoCapitalize="none" spellCheck={false}/></label><p className="helper">Sign in with the Google email your invitation was created for.</p></>}
   {preview&&<>
    <div className="review-card"><p className="eyebrow">{preview.group_kind==='trip'?'Your next shared adventure':'A place with your people'}</p><h2 className="break-word">{preview.group_name}</h2><p className="muted">{preview.already_joined?'You have already joined this group.':preview.invited_name?`${preview.invited_name}, your place is ready. Your own profile will connect to it when you join.`:'Your personal invitation is ready.'}</p></div>
    {preview.group_kind==='trip'&&<p className="callout">This invitation is only for this trip. It does not include access to any household or other trips.</p>}
    {!preview.already_joined&&preview.expense_count>0?<section className="card" aria-labelledby="your-records-heading">
     <h2 id="your-records-heading">Already included</h2><p className="helper">Others recorded {preview.expense_count} {preview.expense_count===1?'current expense':'current expenses'} involving you before you joined. These are your amounts only, after recorded refunds.</p>
     <div className="amount-row"><span>Recorded as paid by you</span><strong>{money(preview.paid_cents)}</strong></div>
     <div className="amount-row"><span>Your recorded share</span><strong>{money(preview.share_cents)}</strong></div>
     <div className="amount-row"><strong>{preview.net_cents>0?'Your recorded credit':preview.net_cents<0?'Your recorded amount owed':'Your recorded balance'}</strong><strong>{money(Math.abs(preview.net_cents))}</strong></div>
     <p className="helper">Joining keeps the original amounts and who recorded them. It does not approve them or confirm that money changed hands. You can review the details and ask an organiser to correct anything after joining.</p>
     <label className="check-row"><input type="checkbox" required checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>I understand these records were added before I joined.</label>
    </section>:!preview.already_joined&&<p className="muted">There are no current expense amounts for you to review. Your people are ready when you are.</p>}
   </>}
   {notice&&<p className="callout" role="status">{notice}</p>}<Alert text={error}/>
   <button className="primary full" disabled={busy||!online||!!preview&&!preview.already_joined&&preview.expense_count>0&&!reviewed}>{busy?'Checking…':joined.current||preview?.already_joined?'Open household or trip':preview?'Accept invitation':'Review invitation'}</button>
  </form>
 </section>;
}
export function InviteForm({group,onBack,online}:FormProps&{group:Group}) {
 const isTrip=group.kind==='trip';
 const [email,setEmail]=useState(''),[recipient,setRecipient]=useState(''),[link,setLink]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
 const [delivery,setDelivery]=useState<InvitationEmailResult|null>(null),[checking,setChecking]=useState(false);
 // Keep the token only for this form's lifetime. Returning later uses the
 // organiser's safe status records, never recovered bearer tokens.
 const flight=useRef(false),pendingToken=useRef('');
 async function submit(event:FormEvent){
  event.preventDefault();if(flight.current||!online)return;
  const emailDelivery=invitationEmailEnabled&&(event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-delivery')!=='link';
  const submitted=email.trim().toLowerCase();flight.current=true;setBusy(true);setError('');setCopied(false);setDelivery(null);
  try{
   const token=await rpc<string>('create_invitation',{p_group:group.id,p_email:submitted});
   if(!/^[0-9a-f]{64}$/.test(token))throw new Error('The invitation link could not be loaded. Return to People and try again.');
   pendingToken.current=token;setRecipient(submitted);setLink(`${location.origin}/#invite=${token}`);moveToTop();
   if(emailDelivery){setDelivery({status:'sending',can_retry:false});setDelivery(await sendInvitationEmail(group.id,token));}
  }catch(e){setError(message(e));}finally{flight.current=false;setBusy(false);}
 }
 async function retryEmail(){
  if(flight.current||!online||!pendingToken.current)return;
  flight.current=true;setBusy(true);setError('');setDelivery(old=>({...old,status:'sending',can_retry:false}));
  try{setDelivery(await sendInvitationEmail(group.id,pendingToken.current));}finally{flight.current=false;setBusy(false);}
 }
 async function checkEmail(){
  if(flight.current||!online||!pendingToken.current)return;
  flight.current=true;setChecking(true);setError('');
  try{
   const rows=await loadInvitationEmailStatus(group.id,pendingToken.current);
   setDelivery(rows[0]??{status:'failed',can_retry:false,error_code:'invalid_invitation'});
  }catch{setError('Email status could not be checked. This does not tell us whether it was sent. Try checking again or share the existing link.');}
  finally{flight.current=false;setChecking(false);}
 }
 const locked=busy||checking;
 const retryAllowed=delivery&&(delivery.can_retry||delivery.status==='not_sent'||delivery.status==='unavailable')&&(!delivery.retry_until||Date.parse(delivery.retry_until)>Date.now());
 async function copy(){try{await navigator.clipboard.writeText(link);setCopied(true);setError('');}catch{setError('Select and copy the invitation link below.');}}
 async function share(){try{await navigator.share({title:`Join ${group.name} on Pact`,text:isTrip?`Join ${group.name} on Pact. This invitation is for this trip only and does not give household access. Use your invited Google account. The link expires in 7 days.`:`Join our household, ${group.name}, on Pact. Use your invited Google account. The link expires in 7 days.`,url:link});}catch(e){if((e as Error).name!=='AbortError')setError('Sharing did not open. Use Copy link instead.');}}
 return <section className="form-page">
  <FormHeader title={link?(delivery?'Your invitation':isTrip?'Share the trip invitation':'Share the invitation'):(isTrip?'Invite a friend':'Invite a flatmate')} context={group.name} onBack={onBack} disabled={locked}/>
  {isTrip&&<p className="callout">This invitation adds them only to <strong className="break-word">{group.name}</strong>. It does not give access to any household or other trips.</p>}
  {link?<>
   <p className="muted">{delivery?'This personal invitation is for ':'Send this link to '}<strong className="break-word">{recipient}</strong>. They can open it and sign in with that Google account.</p>
   {delivery&&<section className="card" aria-label="Invitation email status">
    <div role="status" aria-live="polite"><h2>{invitationEmailLabel(delivery.status)}</h2><p className="helper">{invitationEmailMessage(delivery)}</p></div>
    {delivery.retry_at&&delivery.status!=='sent'&&<p className="helper">Next status check: {new Date(delivery.retry_at).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'})}.</p>}
    <div className="inline-actions">
     {(delivery.status==='sending'||delivery.status==='unknown')&&<button disabled={locked||!online} onClick={()=>void checkEmail()}>{checking?'Checking…':'Check email status'}</button>}
     {retryAllowed&&<button className="primary" disabled={locked||!online} onClick={()=>void retryEmail()}>{busy?'Sending…':delivery.status==='not_sent'?'Send invitation email':'Retry email'}</button>}
    </div>
   </section>}
   <div className="share-actions"><button className={delivery?'':'primary'} disabled={locked} onClick={copy}>{copied&&<Icon name="check"/>}{copied?'Copied':'Copy link'}</button>{typeof navigator.share==='function'&&<button disabled={locked} onClick={share}>Share…</button>}</div>
   <p className="helper" role="status">{copied&&'Link copied. Paste it into your message. '}Expires in 7 days.{!delivery&&' No email is sent automatically.'}</p>
   <label>Invitation link<input readOnly value={link} onFocus={e=>e.target.select()}/></label><Alert text={error}/>
   <div className="form-actions"><button disabled={locked} onClick={()=>{pendingToken.current='';setLink('');setEmail('');setCopied(false);setError('');setDelivery(null);}}>Invite another person</button><button disabled={locked} onClick={onBack}>Done</button></div>
  </>:<form onSubmit={submit}>
   <p className="muted">{invitationEmailEnabled?'Enter their Google email. Pact will email them a personal invitation to join you.':'Enter their Google email, then share their personal invitation link.'}</p>
   <label>Google email<input required disabled={busy} type="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@gmail.com" autoComplete="email" autoCapitalize="none" spellCheck={false}/></label><Alert text={error}/>
   <p className="helper">Creating another invitation for this email and {isTrip?'trip':'household'} replaces their previous invitation. Older links will stop working.</p>
   <button className="primary full" disabled={busy||!online}>{busy?'Creating link…':invitationEmailEnabled?'Send invitation email':'Create invitation link'}</button>
   {invitationEmailEnabled&&<button className="full" data-delivery="link" disabled={busy||!online}>Create a link instead</button>}
   <p className="helper">Expires in 7 days.{invitationEmailEnabled?' They must sign in with their invited Google account.':' No email is sent automatically.'}</p>
  </form>}
 </section>;
}

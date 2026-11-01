import {useEffect,useRef,useState,type FormEvent} from 'react';
import {reauthenticate,rpc,type Group,type Member,type Snapshot} from './api';
import {message} from './errors';
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
 useEffect(()=>{if(kind!=='trip'||!parent)return;let active=true;setMembers(null);setError('');void rpc<Snapshot>('get_household_state',{p_group:parent,p_limit:1}).then(s=>{if(active){setMembers(s.members.filter(m=>m.status==='active'));setPeople([]);}}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[parent,kind]);
 async function submit(event:FormEvent){event.preventDefault();if(locked||!online)return;await mutation.run('create_space',{p_name:name.trim(),p_kind:kind,p_parent:kind==='trip'?parent:null,p_people:kind==='trip'?people:[]},`Create ${kind}`);}
 return <section className="form-page"><FormHeader title={kind==='trip'?'Create a trip':'Create your household'} context="Pact" onBack={onBack} disabled={mutation.busy}/><p className="muted">{kind==='trip'?'Choose who is going. Trip costs stay separate from household costs.':'One shared place for your flatmates, expenses and shopping.'}</p><Recovery mutation={mutation} online={online}/><form onSubmit={submit}><label>{kind==='trip'?'Trip name':'Household name'}<input required maxLength={80} value={name} disabled={locked} onChange={e=>setName(e.target.value)} placeholder={kind==='trip'?'Weekend away':'Our home'}/></label>{kind==='trip'&&<><label>Household<select required value={parent} disabled={locked} onChange={e=>setParent(e.target.value)}>{households.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label><fieldset><legend>Who is going?</legend><p className="helper">Choose household members now. You are included as the trip organiser. You can invite other friends after creating the trip.</p>{!members&&!error?<Loading text="Loading people…"/>:<div className="list-panel">{members?.filter(m=>m.id!==userId).map(m=><label className="check-row" key={m.id}><input type="checkbox" disabled={locked} checked={people.includes(m.id)} onChange={e=>setPeople(old=>e.target.checked?[...old,m.id]:old.filter(id=>id!==m.id))}/>{m.name}</label>)}</div>}</fieldset></>}<Alert text={error}/><button className="primary full" disabled={locked||!online||(kind==='trip'&&(!parent||!members))}>{mutation.busy?'Creating…':`Create ${kind}`}</button>{kind==='household'&&<p className="helper">Invite your flatmates on the next screen.</p>}</form></section>;
}
export function JoinForm({initialToken,email,onBack,online,onJoined}:FormProps&{initialToken:string;email:string;onJoined:(id:string)=>Promise<boolean>}) {
 const [value,setValue]=useState(initialToken),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const joined=useRef(''),flight=useRef(false);
 async function submit(event:FormEvent){event.preventDefault();if(flight.current||!online)return;const token=invitationToken(value);if(!token){setError('Paste the complete invitation link or its 64-character code.');return;}rememberInvite(token);flight.current=true;setBusy(true);setError('');try{if(!joined.current)joined.current=await rpc<string>('accept_invitation',{p_token:token});if(await onJoined(joined.current))clearInvite();else setError('You have joined. Try opening the household or trip again.');}catch(e){setError(message(e));}finally{flight.current=false;setBusy(false);}}
 async function switchAccount(){setError('');try{if(value&&!rememberInvite(value))throw new Error('Paste a valid invitation before switching accounts.');await reauthenticate();}catch(e){setError(message(e));}}
 return <section className="form-page"><FormHeader title="Join your people" context="Pact" onBack={onBack} disabled={busy}/><p className="muted">Joining as <strong className="break-word">{email}</strong>.</p><button className="text-button" disabled={busy||!online} onClick={()=>void switchAccount()}>Use a different Google account</button><form onSubmit={submit}><label>Invitation link or code<input required value={value} disabled={busy||!!joined.current} onChange={e=>setValue(e.target.value)} placeholder="Paste your invitation" autoComplete="off" autoCapitalize="none" spellCheck={false}/></label><p className="helper">Sign in with the Google email your invitation was created for.</p><Alert text={error}/><button className="primary full" disabled={busy||!online}>{busy?'Joining…':joined.current?'Open household or trip':'Accept invitation'}</button></form></section>;
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

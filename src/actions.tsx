import {useEffect,useRef,useState,type FormEvent} from 'react';
import {reauthenticate} from './api';
import {message} from './errors';
import {Alert} from './ui';
import type {useMutation} from './useMutation';
export type Mutation=ReturnType<typeof useMutation>;
export type Prompt={title:string;description:string;button:string;reason?:boolean;amount?:string;run:(value:{reason:string;amount:string})=>Promise<boolean>};
export function Recovery({mutation,online}:{mutation:Mutation;online:boolean}) {
 const [authError,setAuthError]=useState('');
 return <><Alert text={mutation.error||authError}>{mutation.needsAuth&&<button onClick={()=>void reauthenticate().catch(e=>setAuthError(message(e)))}>Sign in again</button>}</Alert>{mutation.pending&&<div className="callout recovery"><div><strong>{mutation.pending.label}</strong><p>This action needs checking. Its original details are saved on this device.</p></div><button onClick={()=>void mutation.check()} disabled={!online||mutation.busy}>{mutation.busy?'Checking…':'Check action'}</button></div>}</>;
}
export function ActionDialog({prompt,busy,blocked,onClose}:{prompt:Prompt;busy:boolean;blocked:boolean;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [reason,setReason]=useState(''),[amount,setAmount]=useState(prompt.amount??''),[error,setError]=useState('');
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 async function submit(event:FormEvent){event.preventDefault();if(busy||blocked)return;setError('');try{await prompt.run({reason:reason.trim(),amount});onClose();}catch(e){setError(message(e));}}
 return <dialog ref={dialog} aria-labelledby="action-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><form onSubmit={submit}><h2 id="action-title">{prompt.title}</h2><p className="muted">{prompt.description}</p>{prompt.amount!==undefined&&<label>Amount · AUD<input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} autoFocus/></label>}{prompt.reason&&<label>Reason<input required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} autoFocus={prompt.amount===undefined}/></label>}<Alert text={error}/><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy||blocked}>{busy?'Saving…':prompt.button}</button></div></form></dialog>;
}

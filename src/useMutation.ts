import {useRef,useState} from 'react';
import {rpc} from './api';
import {authError,definitelyRejected,message} from './errors';

export type OutstandingAction={name:string;args:Record<string,unknown>;label:string};
const key=(user:string,scope:string)=>`pact:action:${user}:${scope}`;
export function readAction(user:string,scope:string):OutstandingAction|null {
  const raw=localStorage.getItem(key(user,scope));
  if(!raw)return null;
  const value=JSON.parse(raw) as OutstandingAction;
  if(typeof value.name!=='string'||!value.args||typeof value.args.p_request!=='string'||typeof value.label!=='string')throw new Error('An unfinished action could not be read. Contact the app owner before repeating it.');
  return value;
}
export function useMutation(user:string,scope:string,onSaved:(result:unknown)=>void|Promise<void>) {
  const [initial]=useState(()=>{try{return {action:readAction(user,scope),error:''};}catch(e){return {action:null,error:message(e)};}});
  const [pending,setPending]=useState<OutstandingAction|null>(initial.action);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(initial.error);
  const [needsAuth,setNeedsAuth]=useState(false);
  const flight=useRef(false);
  async function run(name:string,args:Record<string,unknown>,label:string) {
    if(flight.current||initial.error)return false;
    const action=pending??{name,args:{...args,p_request:crypto.randomUUID()},label};
    try {
      const encoded=JSON.stringify(action);localStorage.setItem(key(user,scope),encoded);
      if(localStorage.getItem(key(user,scope))!==encoded)throw new Error('Storage unavailable');
    }catch{setError('Allow site storage to keep this action safe before saving. Nothing was sent.');return false;}
    flight.current=true;setBusy(true);setError('');setNeedsAuth(false);
    try {
      const result=await rpc(action.name,action.args);
      try{localStorage.removeItem(key(user,scope));}catch{/* Replaying the same committed request is safe. */}
      setPending(null);
      try{await onSaved(result);}catch{setError('Saved. Refresh to load the latest changes.');}
      return true;
    }catch(e){
      if(authError(e)){setPending(action);setNeedsAuth(true);setError('Sign in again to finish checking this action. Its details are saved.');}
      else if(definitelyRejected(e)){localStorage.removeItem(key(user,scope));setPending(null);setError(message(e));}
      else{setPending(action);setError('We could not confirm this action. Check it below to finish the same request safely.');}
      return false;
    }finally{flight.current=false;setBusy(false);}
  }
  return {run,busy,error,pending,needsAuth,clearError:()=>setError(''),check:()=>pending?run(pending.name,pending.args,pending.label):Promise.resolve(false)};
}

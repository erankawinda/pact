import { createClient } from '@supabase/supabase-js';
import {captureInvite} from './invitations';
export {message} from './errors';
export type Group = {id:string;name:string;kind:'household'|'trip';archived_at:string|null;parent_household_id:string|null};
export type Member = {id:string;name:string;role:'organiser'|'member';status:'active'|'revoked'};
export type Expense = {id:string;description:string;amount_cents:number;cash_actor_id:string;occurred_on:string;category:string;note:string;status:string;created_by:string;split_mode:string;version:number;replaces_id:string|null;correction_reason:string};
export type ShoppingItem = {id:string;name:string;quantity:number;remaining:number;unit:string;note:string;urgent:boolean;status:'needed'|'bought'|'removed';claimed_by:string|null;created_by:string;version:number};
export type Purchase = {id:string;item_id:string;quantity:number;created_by:string;created_at:string;expense_id:string|null;undone_at:string|null};
export type Payment = {id:string;sender_id:string;recipient_id:string;amount_cents:number;occurred_on:string;note:string;status:'pending'|'confirmed'|'rejected'|'cancelled'|'reversed';version:number;reason:string};
export type Refund = {id:string;expense_id:string;amount_cents:number;reason:string;status:'posted'|'voided';created_by:string;created_at:string};
export type Activity = {id:string;actor_id:string;action:string;entity_id:string;occurred_at:string;after_data:Record<string,unknown>};
export type Snapshot = {members:Member[];expenses:Expense[];shares:{expense_id:string;user_id:string;share_cents:number}[];balances:{user_id:string;cents:number}[];shopping:ShoppingItem[];purchases:Purchase[];payments:Payment[];refunds:Refund[];refund_shares:{refund_id:string;user_id:string;share_cents:number}[];activity:Activity[];invitations:{id:string;intended_email:string;expires_at:string}[];expense_count:number};
export type ExpenseInput = {p_group:string;p_request:string;p_description:string;p_amount:number;p_payer:string;p_people:string[];p_mode:'equal'|'exact';p_exact:Record<string,number>|null;p_date:string;p_category:string;p_note:string};
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
// Capture invitations before OAuth redirects replace the URL fragment.
captureInvite();
export const configured = Boolean(url && key && !url.includes('YOUR_PROJECT') && !key.includes('YOUR_PUBLIC'));
export const REQUEST_TIMEOUT_MS = 25_000;
// Covers Auth refreshes as well as the Data API. Abort never implies a write rolled back.
async function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const parent = init?.signal;
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  try { return await fetch(input, {...init, signal:controller.signal}); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
export const client = configured ? createClient(url,key,{global:{fetch:boundedFetch},auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}}) : null;

export async function signInGoogle() {
  if (!client) throw new Error('Pact is not connected yet.');
  const {error} = await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+'/',scopes:'openid email profile',queryParams:{prompt:'select_account'}}});
  if (error) throw error;
}

export async function reauthenticate() {
  // Drafts and outstanding requests are stored separately from the Auth session.
  try { sessionStorage.setItem('pact:return-to', location.pathname + location.search); } catch { /* Optional return route. */ }
  await signInGoogle();
}

export function categoryLabel(category: string): string {
  return ({groceries:'Groceries',takeaway:'Takeout',household:'Household',travel:'Travel',other:'Other'} as Record<string,string>)[category] ?? category;
}
export async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T> {
  if (!client) throw new Error('The app has not been connected yet.');
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Request timed out'));},30_000);});
    const {data,error}=await Promise.race([client.rpc(name,args).abortSignal(controller.signal),timeout]);
    if(error)throw error;
    return data as T;
  }finally{clearTimeout(timer);}
}
export async function listGroups():Promise<Group[]> {
  if(!client) return [];
  const {data,error} = await client.from('groups').select('id,name,kind,archived_at,parent_household_id').order('created_at');
  if(error) throw error;
  return data as Group[];
}

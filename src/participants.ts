import type {Member,Snapshot} from './api';

export function ownMembership(snapshot:Snapshot,userId:string):Member|undefined{
  return snapshot.members.find(member=>member.auth_user_id===userId&&member.status==='active');
}
export function isOrganiser(snapshot:Snapshot,userId:string):boolean{
  return ownMembership(snapshot,userId)?.role==='organiser';
}
/** These names describe actual actors; pending participants cannot act. */
export function actorNames(snapshot:Snapshot):Record<string,string>{
  return Object.fromEntries(snapshot.members.filter(member=>member.auth_user_id).map(member=>[member.auth_user_id!,member.name]));
}
export function participantPhotoId(member:Member|undefined):string|undefined{
  return member?.status==='active'?member.auth_user_id??undefined:undefined;
}
export function participantState(member:Member):string{
  return member.status==='invited'?'Invited':member.status==='expired'?'Invitation expired':member.status==='revoked'?member.auth_user_id?'Former member':'Invitation revoked':'';
}
export function hasUnjoinedBalance(snapshot:Snapshot):boolean{
  const unjoined=new Set(snapshot.members.filter(member=>!member.auth_user_id).map(member=>member.id));
  // Never remove a pending balance then calculate suggestions for the remainder:
  // that would change who owes whom and may no longer be a zero-sum ledger.
  return snapshot.balances.some(balance=>unjoined.has(balance.user_id)&&balance.cents!==0);
}
export function newInvitationToken():string{
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

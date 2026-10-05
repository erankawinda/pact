import {useCallback,useEffect,useRef,useState} from 'react';
import {client,listGroups,rpc,type Group,type Snapshot} from './api';
import {accessError,message} from './errors';

export function useHousehold(userId:string,preferred:string) {
 const [groups,setGroups]=useState<Group[]>([]),[groupId,setGroupId]=useState('');
 const [loaded,setLoaded]=useState(false),[groupError,setGroupError]=useState(''),[dataError,setDataError]=useState('');
 const [data,setData]=useState<{id:string;value:Snapshot}|null>(null);
 const [online,setOnline]=useState(navigator.onLine),[refreshing,setRefreshing]=useState(false),[live,setLive]=useState(true),[lastUpdated,setLastUpdated]=useState<number|null>(null);
 const current=useRef(''),groupRequest=useRef(0),dataRequest=useRef(0),limit=useRef(50),refreshFlight=useRef<Promise<void>|null>(null),refreshQueued=useRef(false),preferredRef=useRef(preferred);
 preferredRef.current=preferred;
 const preferenceKey=`pact:last-group:${userId}`;
 const selectGroup=useCallback((id:string)=>{
  if(current.current!==id){limit.current=50;dataRequest.current++;setLastUpdated(null);}
  current.current=id;setGroupId(id);setDataError('');
  try{localStorage.setItem(preferenceKey,id);}catch{/* Optional preference. */}
 },[preferenceKey]);
 const loadGroups=useCallback(async(prefer?:string)=>{
  const request=++groupRequest.current;
  try{
   const next=await listGroups();if(request!==groupRequest.current)return false;
   let remembered='';try{remembered=localStorage.getItem(preferenceKey)??'';}catch{/* Optional preference. */}
   const id=[prefer,preferredRef.current,current.current,remembered].find(id=>id&&next.some(g=>g.id===id))??next.find(g=>g.kind==='household'&&!g.archived_at)?.id??next[0]?.id??'';
   setGroups(next);setLoaded(true);setGroupError('');if(current.current!==id)selectGroup(id);
   if(prefer&&!next.some(g=>g.id===prefer)){setGroupError('Saved, but your household has not loaded yet. Refresh to try again.');return false;}
   return true;
  }catch(e){if(request===groupRequest.current){setGroupError(message(e));if(accessError(e)){setGroups([]);setData(null);}}return false;}
 },[preferenceKey,selectGroup]);
 const loadSnapshot=useCallback(async(id:string)=>{
  const request=++dataRequest.current;
  if(!id){setData(null);return;}
  try{
   const next=await rpc<Snapshot>('get_household_state',{p_group:id,p_limit:limit.current});
   if(request===dataRequest.current&&current.current===id){setData({id,value:next});setDataError('');setLastUpdated(Date.now());}
  }catch(e){if(request===dataRequest.current&&current.current===id){if(accessError(e))setData(null);setDataError(message(e));}}
 },[]);
 const refresh=useCallback(()=>{
  if(refreshFlight.current){refreshQueued.current=true;return refreshFlight.current;}
  setRefreshing(true);
  const task=(async()=>{do{refreshQueued.current=false;await loadGroups();await loadSnapshot(current.current);}while(refreshQueued.current);})().finally(()=>{refreshFlight.current=null;setRefreshing(false);});
  refreshFlight.current=task;return task;
 },[loadGroups,loadSnapshot]);
 const loadMore=useCallback(async()=>{limit.current=Math.min(limit.current+50,10000);await loadSnapshot(current.current);},[loadSnapshot]);
 useEffect(()=>{void loadGroups();return()=>{groupRequest.current++;dataRequest.current++;};},[loadGroups]);
 useEffect(()=>{if(preferred&&groups.some(g=>g.id===preferred)&&preferred!==current.current)selectGroup(preferred);},[preferred,groups,selectGroup]);
 useEffect(()=>{void loadSnapshot(groupId);},[groupId,loadSnapshot]);
 useEffect(()=>{
  const recover=()=>{setOnline(navigator.onLine);if(navigator.onLine)void refresh();};
  const offline=()=>setOnline(false),visible=()=>{if(document.visibilityState==='visible')recover();};
  window.addEventListener('online',recover);window.addEventListener('offline',offline);window.addEventListener('focus',recover);document.addEventListener('visibilitychange',visible);
  const interval=setInterval(()=>{if(navigator.onLine&&document.visibilityState==='visible')void refresh();},30000);
  let channel=groupId&&client?client.channel(`pact-${userId}-${groupId}`):null;
  if(channel){
   for(const table of ['expenses','expense_refunds','refund_shares','payments','shopping_items','shopping_purchases','group_members'])channel=channel.on('postgres_changes',{event:'*',schema:'public',table,filter:`group_id=eq.${groupId}`},recover);
   channel.on('postgres_changes',{event:'*',schema:'public',table:'groups',filter:`id=eq.${groupId}`},recover).subscribe(status=>{
    setLive(status==='SUBSCRIBED');
    if(status==='SUBSCRIBED')recover();
   });
  }
  return()=>{clearInterval(interval);window.removeEventListener('online',recover);window.removeEventListener('offline',offline);window.removeEventListener('focus',recover);document.removeEventListener('visibilitychange',visible);if(channel&&client)void client.removeChannel(channel);};
 },[groupId,userId,refresh]);
 return {groups,groupId,group:groups.find(g=>g.id===groupId),snapshot:data?.id===groupId?data.value:null,loaded,groupError,dataError,online,refreshing,live,lastUpdated,loadGroups,selectGroup,refresh,loadMore};
}

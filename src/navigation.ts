import {useEffect, useState} from 'react';

export type Screen = 'home'|'shopping'|'expenses'|'balances'|'people'|'groups'|'account'|'household'|'trip'|'invite'|'join'|'expense'|'payment'|'activity'|'settings';
export type Route = {screen:Screen;group:string;edit:string;purchase:string;to:string;amount:string};
const screens:Screen[]=['home','shopping','expenses','balances','people','groups','account','household','trip','invite','join','expense','payment','activity','settings'];
function readRoute():Route {
  const p=new URLSearchParams(location.search);
  const screen=p.get('screen') as Screen;
  return {screen:screens.includes(screen)?screen:'home',group:p.get('household')??'',edit:p.get('edit')??'',purchase:p.get('purchase')??'',to:p.get('to')??'',amount:p.get('amount')??''};
}
export function useRoute() {
  const [route,setRoute]=useState(readRoute);
  useEffect(()=>{const onPop=()=>setRoute(readRoute());window.addEventListener('popstate',onPop);return()=>window.removeEventListener('popstate',onPop);},[]);
  function navigate(screen:Screen,options:Partial<Omit<Route,'screen'>>={},replace=false) {
    const next:Route={screen,group:options.group??route.group,edit:options.edit??'',purchase:options.purchase??'',to:options.to??'',amount:options.amount??''};
    const url=new URL(location.href);
    // Preserve any unrelated query values, but never propagate a consumed OAuth code.
    for(const key of ['screen','household','edit','purchase','to','amount','code'])url.searchParams.delete(key);
    if(screen!=='home')url.searchParams.set('screen',screen);
    for(const [key,value] of Object.entries({...next,screen:''}))if(value)url.searchParams.set(key==='group'?'household':key,value);
    if(url.pathname+url.search===location.pathname+location.search) {setRoute(next);return;}
    history[replace?'replaceState':'pushState']({pact:true},'',url.pathname+url.search+url.hash);
    setRoute(next);
  }
  function back(fallback:Screen='home') {
    if(history.state?.pact && history.length>1)history.back();else navigate(fallback,{},true);
  }
  return {route,navigate,back};
}

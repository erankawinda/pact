import {createContext,useContext,useEffect,useMemo,useSyncExternalStore,type ReactNode} from 'react';
import {fetchPhoto,photosEnabled} from './photoApi';

type Entry = {url:string|null;pending:boolean};
function makeStore() {
  const entries = new Map<string,Entry>(), listeners = new Set<()=>void>();
  let generation = 0;
  const emit = () => {for (const listener of listeners) listener();};
  return {
    subscribe(listener:()=>void) {listeners.add(listener);return()=>{listeners.delete(listener);};},
    read(id:string) {return entries.get(id)?.url ?? null;},
    clear() {
      generation++;
      for (const entry of entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
      entries.clear();emit();
    },
    async load(id:string) {
      if (!photosEnabled || !id || entries.has(id)) return;
      const started = generation;
      entries.set(id,{url:null,pending:true});
      try {
        const photo = await fetchPhoto(id);
        if (generation !== started) return;
        entries.set(id,{url:photo?URL.createObjectURL(photo):null,pending:false});
      } catch {
        if (generation !== started) return;
        entries.set(id,{url:null,pending:false});
      }
      emit();
    },
  };
}
type Store = ReturnType<typeof makeStore>;
const Photos = createContext<Store|null>(null);
export function PhotoProvider({scope,children}:{scope:string;children:ReactNode}) {
  const store = useMemo(makeStore,[scope]);
  useEffect(()=>{
    const changed = () => store.clear();
    const visible = () => {if(document.visibilityState==='visible')store.clear();};
    window.addEventListener('pact:photos-changed',changed);
    document.addEventListener('visibilitychange',visible);
    const timer = setInterval(changed,30_000);
    return()=>{clearInterval(timer);window.removeEventListener('pact:photos-changed',changed);document.removeEventListener('visibilitychange',visible);store.clear();};
  },[store]);
  return <Photos.Provider value={store}>{children}</Photos.Provider>;
}
const noopSubscribe = () => () => {};
const empty = () => null;
export function usePhoto(userId?:string) {
  const store = useContext(Photos);
  const url = useSyncExternalStore(store?.subscribe??noopSubscribe,()=>userId?store?.read(userId)??null:null,empty);
  // A clear emits even when a previously absent photo was null. A separate effect
  // listener reloads visible avatars, including photos added in another tab.
  useEffect(()=>{
    if(!store||!userId)return;
    const load=()=>{void store.load(userId);};load();return store.subscribe(load);
  },[store,userId]);
  return url;
}
export function photosChanged() {window.dispatchEvent(new Event('pact:photos-changed'));}

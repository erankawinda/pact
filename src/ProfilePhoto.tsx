import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {fetchPhotoStatus,photosEnabled,removePhoto,uploadPhoto,type PhotoStatus} from './photoApi';
import {prepareProfilePhoto} from './photoProcessing';
import {photosChanged} from './PhotoContext';
import {Alert,Avatar,Loading} from './ui';
import {message} from './errors';

export function ProfilePhoto({userId,name,online}:{userId:string;name:string;online:boolean}) {
  const [status,setStatus]=useState<PhotoStatus|null>(null),[photo,setPhoto]=useState<Blob|null>(null),[preview,setPreview]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [deletePrompt,setDeletePrompt]=useState(false);
  const flight=useRef(false), input=useRef<HTMLInputElement>(null), uploadId=useRef(''),deleteId=useRef('');
  async function reload(){setError('');try{setStatus(await fetchPhotoStatus(userId));photosChanged();}catch(e){setError(message(e));}}
  useEffect(()=>{if(!photosEnabled)return;let active=true;void fetchPhotoStatus(userId).then(value=>{if(active)setStatus(value);}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[userId]);
  useEffect(()=>{if(!photo){setPreview('');return;}const url=URL.createObjectURL(photo);setPreview(url);return()=>URL.revokeObjectURL(url);},[photo]);
  if(!photosEnabled)return null;
  async function choose(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];event.target.value='';if(!file||flight.current)return;
    flight.current=true;setBusy(true);setError('');setNotice('');setPhoto(null);
    try{setPhoto(await prepareProfilePhoto(file));uploadId.current=crypto.randomUUID();}
    catch(e){setError(message(e));}finally{flight.current=false;setBusy(false);}
  }
  async function save(){
    if(!photo||flight.current||!online)return;
    flight.current=true;setBusy(true);setError('');setNotice('');
    try{const current=await uploadPhoto(photo,uploadId.current,userId);setStatus(current);setPhoto(null);setNotice(current.status==='ready'?'Looking good. Your photo is saved.':'Your upload is still being checked. Refresh its status in a moment.');photosChanged();}
    catch(e){setError(message(e));try{const current=await fetchPhotoStatus(userId);setStatus(current);if(current.status==='ready'){setPhoto(null);setNotice('Your photo is saved.');photosChanged();}}catch{/* Keep the same upload for a safe retry. */}}
    finally{flight.current=false;setBusy(false);}
  }
  async function remove(){
    const version=status?.version??status?.operation_id;
    if(flight.current||!online||!version)return;flight.current=true;setBusy(true);setError('');setNotice('');
    deleteId.current ||= crypto.randomUUID();
    try{const current=await removePhoto(deleteId.current,version,userId);setStatus(current);setPhoto(null);if(current.status==='empty')deleteId.current='';setDeletePrompt(false);setNotice(current.status==='empty'?'Photo removed. You can add a new one whenever you like.':'Your photo is hidden while deletion finishes.');photosChanged();}
    catch(e){setError(message(e));await fetchPhotoStatus(userId).then(current=>{
      setStatus(current);
      if((current.version??current.operation_id)!==version){
        deleteId.current='';setDeletePrompt(false);
        setNotice('Your photo changed. Check the current photo before removing it.');
      }
    }).catch(()=>{});photosChanged();}
    finally{flight.current=false;setBusy(false);}
  }
  return <section className="card account-section" aria-labelledby="profile-photo-heading">
    <h2 id="profile-photo-heading">A face to your name</h2>
    <p className="helper">Your photo is visible to current members who share a household or trip with you.</p>
    <div className="profile-photo-preview">{preview?<img src={preview} alt="Your new profile photo preview"/>:<Avatar name={name} userId={userId}/>}</div>
    <Alert text={error}/>{notice&&<p className="notice" role="status">{notice}</p>}
    {!status?<>{!error&&<Loading text="Loading your photo…"/>}<button onClick={()=>void reload()} disabled={!online||busy}>Check photo status</button></>:status.status==='empty'?<>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="sr-only" tabIndex={-1} aria-label="Choose profile photo" onChange={event=>void choose(event)}/>
      <div className="stack-actions"><button disabled={busy||!online} onClick={()=>input.current?.click()}>{busy?'Preparing your photo…':photo?'Choose another photo':'Choose a photo'}</button>{photo&&<><button className="primary" onClick={()=>void save()} disabled={!online||busy}>{busy?'Saving…':'Save photo'}</button><button className="text-button" disabled={busy} onClick={()=>setPhoto(null)}>Discard preview</button></>}</div>
      <p className="helper">Up to 25 MiB and 64 megapixels. JPEG, PNG and WebP; HEIC when your browser supports it. We make a square crop—check the preview before saving.</p>
      <p className="helper">Your original stays on this device. Only a small copy, up to 256 KiB, is uploaded. Location and camera metadata are removed.</p>
    </>:<>
      {status.status==='ready'?<p className="helper">To choose a different photo, delete this one first.</p>:<p className="callout" role="status">{status.status==='uploading'?'An earlier upload needs finishing. Check its status, or remove it before choosing again.':'Your photo is hidden while deletion finishes. Retry removal before adding a new one.'}</p>}
      {deletePrompt?<div className="callout"><p>Delete your profile photo? Your initials will appear in its place.</p><div className="stack-actions"><button className="danger" disabled={!online||busy} onClick={()=>void remove()}>{busy?'Removing…':'Delete photo'}</button><button disabled={busy} onClick={()=>setDeletePrompt(false)}>Keep photo</button></div></div>:<button disabled={!online||busy} onClick={()=>setDeletePrompt(true)}>{status.status==='deleting'?'Retry photo removal':'Remove photo'}</button>}
      {status.status!=='ready'&&<button className="text-button" disabled={!online||busy} onClick={()=>void reload()}>Check photo status</button>}
    </>}
  </section>;
}

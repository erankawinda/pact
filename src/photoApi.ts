import {client} from './api';

export const photosEnabled = import.meta.env.VITE_PROFILE_PHOTOS_ENABLED === 'true';
export type PhotoStatus = {status:'empty'|'uploading'|'ready'|'deleting';version:string|null;operation_id?:string;retry_at?:string};
async function request(method: 'GET'|'POST'|'DELETE', params: URLSearchParams, requestId?: string, photo?: Blob, version?:string, expectedOwner?:string) {
  if (!photosEnabled || !client) throw new Error('Profile photos are not available in this version yet.');
  const {data, error} = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error('Sign in again to manage your photo.');
  if (expectedOwner && data.session.user.id !== expectedOwner) throw new Error('Your account changed. Open your profile again before changing its photo.');
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),25_000);
  try {
    return await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/profile-photo?${params}`, {
      method, body:photo, signal:controller.signal, cache:'no-store', redirect:'error',
      headers:{Authorization:`Bearer ${data.session.access_token}`, apikey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        ...(requestId?{'X-Request-Id':requestId}:{}), ...(version?{'X-Photo-Version':version}:{}), ...(photo?{'Content-Type':'image/jpeg'}:{})},
    });
  } finally { clearTimeout(timer); }
}
async function failure(response: Response): Promise<never> {
  const data = await response.json().catch(()=>null);
  throw new Error(typeof data?.message === 'string' ? data.message : 'Your photo could not be updated. Check your connection and try again.');
}
export async function fetchPhotoStatus(userId: string): Promise<PhotoStatus> {
  const response = await request('GET',new URLSearchParams({user_id:userId,status:'1'}));
  if (!response.ok) return failure(response);
  const value = await response.json();
  if (!['empty','uploading','ready','deleting'].includes(value.status)) throw new Error('Your photo status could not be loaded.');
  return value;
}
export async function fetchPhoto(userId: string): Promise<Blob|null> {
  const response = await request('GET',new URLSearchParams({user_id:userId}));
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) return failure(response);
  const photo = await response.blob();
  if (photo.type !== 'image/jpeg' || photo.size > 262144) throw new Error('Your photo could not be loaded.');
  return photo;
}
export async function uploadPhoto(photo: Blob, requestId: string, userId:string): Promise<PhotoStatus> {
  const response = await request('POST',new URLSearchParams(),requestId,photo,undefined,userId);
  if (!response.ok) return failure(response);
  return await response.json();
}
export async function removePhoto(requestId: string, version:string, userId:string): Promise<PhotoStatus> {
  const response = await request('DELETE',new URLSearchParams(),requestId,undefined,version,userId);
  if (!response.ok) return failure(response);
  return await response.json();
}

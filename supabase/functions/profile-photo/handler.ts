import {PhotoError, readPhotoBody, sanitizePhoto} from './image.ts';

type Slot = {status: 'empty'|'uploading'|'ready'|'deleting'|'cleanup'; generation?: string; object_path?: string; request_id?: string; retry_at?: string; claimed?: boolean};
export type PhotoServices = {
  authenticate: (token: string) => Promise<string>;
  action: (user: string, action: string, args?: {request?: string; version?: string; digest?: string; target?: string}) => Promise<Slot>;
  upload: (path: string, bytes: Uint8Array) => Promise<void>;
  remove: (path: string) => Promise<void>;
  download: (path: string) => Promise<Blob>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: string | null, name: string): string {
  if (!value || !UUID.test(value)) throw new PhotoError('photo_invalid_request', `${name} is required.`);
  return value.toLowerCase();
}
function publicStatus(slot: Slot) {
  if (slot.status === 'ready') return {status: 'ready', version: slot.generation};
  if (slot.status === 'empty') return {status: 'empty'};
  return {status: slot.status === 'cleanup' ? 'uploading' : slot.status, operation_id: slot.generation, retry_at: slot.retry_at};
}
function safeError(error: unknown): PhotoError {
  if (error instanceof PhotoError) return error;
  const text = typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
  const code = /^([a-z_]+):/.exec(text)?.[1];
  const errors: Record<string, [number, string]> = {
    photo_unauthenticated: [401, 'Sign in again to manage your photo.'],
    photo_forbidden: [403, 'This photo operation is not available to your account.'],
    photo_not_found: [404, 'Photo is unavailable.'],
    photo_invalid_request: [400, 'The photo request is incomplete. Refresh and try again.'],
    photo_request_conflict: [409, 'This request was already used. Refresh before trying again.'],
    photo_request_finished: [409, 'This photo request has ended. Choose the photo again.'],
    photo_stale_operation: [409, 'The photo changed. Refresh before trying again.'],
    photo_exists: [409, 'Remove your current photo before uploading another.'],
    photo_busy: [409, 'A photo operation is still being checked. Refresh its status before trying again.'],
    photo_rate_limit: [429, 'Too many photo uploads. Try again later.'],
    photo_storage_missing: [503, 'The photo save could not be confirmed. Check its status before trying again.'],
    photo_storage_remaining: [503, 'Photo removal is unfinished. Retry removing it.'],
  };
  if (code && errors[code]) return new PhotoError(code, errors[code][1], errors[code][0]);
  return new PhotoError('photo_unavailable', 'The photo operation could not be confirmed. Refresh its status before trying again.', 503);
}

/** No cookies or signed URLs: every read and write is authenticated afresh. */
export function photoHandler(services: PhotoServices) {
  return async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-request-id, x-photo-version, x-client-info',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Cache-Control': 'private, no-store, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Authorization',
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...headers, 'Content-Type': 'application/json'}});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    try {
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new PhotoError('photo_method', 'This request method is not supported.', 405);
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!token) throw new PhotoError('photo_unauthenticated', 'Sign in again to manage your photo.', 401);
      const user = await services.authenticate(token);
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const target = url.searchParams.has('user_id') ? uuid(url.searchParams.get('user_id'), 'User ID') : user;
        if (url.searchParams.get('status') === '1') return json(publicStatus(await services.action(user, 'status', {target})));
        const slot = await services.action(user, 'read', {target});
        const image = await services.download(slot.object_path!);
        // Recheck after fetching so a concurrent deletion/revocation cannot use a stale first authorisation.
        const current = await services.action(user, 'read', {target});
        if (current.generation !== slot.generation) throw new PhotoError('photo_not_found', 'Photo is unavailable.', 404);
        return new Response(image, {headers: {...headers, 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline'}});
      }
      const requestId = uuid(request.headers.get('x-request-id'), 'Request ID');
      if (request.method === 'DELETE') {
        const version = uuid(request.headers.get('x-photo-version'), 'Photo version');
        const slot = await services.action(user, 'begin_delete', {request: requestId, version});
        if (slot.status === 'empty') return json({status: 'empty'});
        await services.remove(slot.object_path!);
        await services.action(user, 'complete_delete', {request: requestId, version});
        return json({status: 'empty'});
      }
      const source = await readPhotoBody(request);
      const bytes = sanitizePhoto(source);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', source)), value => value.toString(16).padStart(2, '0')).join('');
      let slot = await services.action(user, 'reserve', {request: requestId, digest});
      if (slot.status === 'cleanup') {
        // The ten-minute lease exceeds the longest hosted function lifetime.
        // A failed old worker cannot still be writing this immutable generation.
        await services.remove(slot.object_path!);
        await services.action(user, 'cleanup_upload', {version: slot.generation});
        slot = await services.action(user, 'reserve', {request: requestId, digest});
      }
      if (slot.status === 'ready') return json(publicStatus(slot));
      if (!slot.claimed) return json(publicStatus(slot), 202);
      await services.upload(slot.object_path!, bytes);
      const ready = await services.action(user, 'complete', {request: requestId, digest});
      return json(publicStatus(ready), 201);
    } catch (error) {
      // A network failure never means a write rolled back. Keep the slot for
      // status checks and fenced cleanup rather than deleting a possibly saved photo.
      const safe = safeError(error);
      return json({error: safe.code, message: safe.message}, safe.status);
    }
  };
}

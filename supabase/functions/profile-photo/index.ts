import {createClient} from '@supabase/supabase-js';
import {PhotoError, MAX_PHOTO_BYTES} from './image.ts';
import {photoHandler} from './handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
function serviceSecret(): string {
  try {
    const keys: unknown = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys && typeof keys === 'object' && 'default' in keys && typeof keys.default === 'string' && keys.default) return keys.default;
  } catch { /* Older projects may expose only the legacy environment variable. */ }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!legacy) throw new Error('The private photo service is not configured.');
  return legacy;
}
const serviceKey = serviceSecret();
const admin = createClient(url, serviceKey, {
  auth: {persistSession: false, autoRefreshToken: false},
  global: {fetch: async (input, init) => fetch(input, {...init, signal: AbortSignal.timeout(20_000)})},
});
const bucket = admin.storage.from('profile-photos');

Deno.serve(photoHandler({
  async authenticate(token) {
    // Validate against Auth, not unverified JWT payloads or user-editable metadata.
    const {data, error} = await admin.auth.getUser(token);
    const user = data.user;
    if (error || !user?.email_confirmed_at || !Array.isArray(user.app_metadata.providers) || !user.app_metadata.providers.includes('google')) {
      throw new PhotoError('photo_unauthenticated', 'Sign in again with your Google account.', 401);
    }
    return user.id;
  },
  async action(user, action, args = {}) {
    const {data, error} = await admin.rpc('profile_photo_action', {p_user: user, p_action: action,
      p_request: args.request ?? null, p_version: args.version ?? null, p_digest: args.digest ?? null, p_target: args.target ?? null});
    if (error) throw error;
    return data;
  },
  async upload(path, bytes) {
    const {error} = await bucket.upload(path, bytes, {contentType: 'image/jpeg', cacheControl: '0', upsert: false});
    if (error) throw error;
  },
  async remove(path) {
    const {error} = await bucket.remove([path]);
    if (error) throw error;
  },
  async download(path) {
    const {data, error} = await bucket.download(path);
    if (error || !data || data.size > MAX_PHOTO_BYTES || data.type !== 'image/jpeg') {
      throw new PhotoError('photo_not_found', 'Photo is unavailable.', 404);
    }
    return data;
  },
}));

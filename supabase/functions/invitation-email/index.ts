import { createClient } from '@supabase/supabase-js';
import { invitationEmailHandler, type Claim, type Receipt } from './handler.ts';

function secret(): string {
  try {
    const keys: unknown = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys && typeof keys === 'object' && 'default' in keys && typeof keys.default === 'string') return keys.default;
  } catch { /* Legacy projects expose only SUPABASE_SERVICE_ROLE_KEY. */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}
const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = secret();
const config = {
  enabled: Deno.env.get('INVITATION_EMAIL_ENABLED') === 'true' && !!url && !!serviceKey,
  origin: Deno.env.get('PACT_APP_ORIGIN') ?? '',
  sender: Deno.env.get('PACT_INVITATION_FROM') ?? '',
  apiKey: Deno.env.get('RESEND_API_KEY') ?? '',
};
// Lazy creation lets unconfigured deployments return a safe, explicit 503.
const admin = () => createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' }) },
});
Deno.serve(invitationEmailHandler(config, {
  async authenticate(token) {
    const { data, error } = await admin().auth.getUser(token);
    const user = data.user;
    // Permissions come from the database, never user_metadata or decoded JWT claims.
    if (error || !user?.email_confirmed_at || !Array.isArray(user.app_metadata.providers) ||
      !user.app_metadata.providers.includes('google')) throw new Error('invitation_email_unauthenticated');
    return user.id;
  },
  async begin(args) {
    const { data, error } = await admin().rpc('begin_invitation_email', {
      p_actor: args.actor, p_group: args.group, p_token_hash: args.tokenHash,
      p_sender: args.sender, p_origin: args.origin, p_template: args.template,
    });
    if (error) throw error;
    return data as Claim;
  },
  async finish(args) {
    const { data, error } = await admin().rpc('finish_invitation_email', {
      p_delivery: args.delivery, p_lease: args.lease, p_status: args.status,
      p_provider_id: args.providerId ?? null, p_error_code: args.errorCode ?? null,
    });
    if (error) throw error;
    return data as Receipt;
  },
  fetch,
}));

import { createClient } from '@supabase/supabase-js';
import webPush from 'web-push';
import { equalSecret, isPushEndpoint, retrySeconds } from './delivery.ts';

type Claim = { id: string; lease_token: string };
type Delivery = {
  id: string; endpoint: string; p256dh: string; auth: string; binding: string;
  category: 'expenses' | 'refunds' | 'repayments' | 'test'; tone: 'friendly' | 'brief'; attempts: number; expires_at: string;
};
type Outcome = 'sent' | 'retry' | 'gone' | 'dead';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function reply(status: number, body: Record<string, unknown>) { return new Response(JSON.stringify(body), { status, headers }); }
function serverKey(): string | undefined {
  // Hosted functions provide named modern secret keys as a JSON dictionary.
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (typeof keys.default === 'string' && keys.default.startsWith('sb_secret_')) return keys.default;
  } catch { /* A legacy hosted project can still use its server-only role key. */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}
Deno.serve(async request => {
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const dispatchSecret = Deno.env.get('PACT_DISPATCH_SECRET');
  if (!dispatchSecret || dispatchSecret.length < 32) return reply(503, { error: 'dispatcher_not_configured' });
  if (!await equalSecret(request.headers.get('x-pact-dispatch-key') ?? '', dispatchSecret)) return reply(401, { error: 'unauthorized' });
  const url = Deno.env.get('SUPABASE_URL'), key = serverKey();
  const vapidDetails = { subject: Deno.env.get('VAPID_SUBJECT') ?? '', publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '', privateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '' };
  if (!url || !key || !vapidDetails.publicKey || !vapidDetails.privateKey || !/^(https:\/\/[^/]+|mailto:)/.test(vapidDetails.subject)) return reply(503, { error: 'dispatcher_not_configured' });
  // Supabase gateway requires the secret in apikey. No user session is accepted here.
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) },
  });
  const counts = { claimed: 0, sent: 0, retried: 0, gone: 0, dead: 0, skipped: 0, errors: 0 };
  try {
    const { data, error } = await db.rpc('claim_notification_deliveries', { p_limit: 12 });
    if (error || !Array.isArray(data)) return reply(503, { error: 'queue_unavailable' });
    const claims = data as Claim[];
    counts.claimed = claims.length;
    async function deliver(claim: Claim): Promise<void> {
      let outcome: Outcome = 'retry', status: number | null = null, delay = 60;
      const { data, error } = await db.rpc('get_notification_delivery', { p_id: claim.id, p_lease: claim.lease_token });
      if (error) { counts.errors++; return; } // The lease expires and can be reclaimed.
      if (!data) { counts.skipped++; return; }
      const item = data as Delivery;
      if (!isPushEndpoint(item.endpoint)) outcome = 'dead';
      else {
        const ttl = Math.max(0, Math.min(3600, Math.floor((Date.parse(item.expires_at) - Date.now()) / 1000)));
        if (!ttl) outcome = 'dead';
        else {
          let details;
          try {
            // Encrypt only identifiers and presentation choices. The SW supplies the fixed generic text.
            details = webPush.generateRequestDetails({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
              JSON.stringify({ id: item.id, binding: item.binding, category: item.category, tone: item.tone }),
              { vapidDetails, TTL: ttl, urgency: 'normal', contentEncoding: 'aes128gcm', topic: item.id.replaceAll('-', '') });
          } catch { outcome = 'dead'; }
          if (details) {
            try {
              const response = await fetch(item.endpoint, { method: 'POST', headers: details.headers,
                body: new Uint8Array(details.body), redirect: 'error', signal: AbortSignal.timeout(10000) });
              status = response.status;
              await response.body?.cancel(); // Provider error bodies may contain private endpoint details.
              if (response.ok) outcome = 'sent';
              else if (status === 404 || status === 410) outcome = 'gone';
              else if (status === 429 || status >= 500) { outcome = 'retry'; delay = retrySeconds(response.headers.get('Retry-After'), item.attempts); }
              else outcome = 'dead';
            } catch { outcome = 'retry'; delay = retrySeconds(null, item.attempts); }
          }
        }
      }
      const result = await db.rpc('finish_notification_delivery', { p_id: claim.id, p_lease: claim.lease_token, p_outcome: outcome, p_status: status, p_retry_seconds: delay });
      if (result.error || result.data !== true) counts.errors++;
      else if (outcome === 'retry') counts.retried++;
      else counts[outcome]++;
    }
    // Three groups of four requests stay inside a 2-minute lease and the free runtime's wall limit.
    for (let i = 0; i < claims.length; i += 4) {
      const results = await Promise.allSettled(claims.slice(i, i + 4).map(deliver));
      for (const result of results) if (result.status === 'rejected') counts.errors++;
    }
    return reply(counts.errors ? 503 : 200, counts);
  } catch { return reply(503, { error: 'dispatch_incomplete' }); }
});

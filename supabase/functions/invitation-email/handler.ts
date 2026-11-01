/** Invitation tokens exist only in this request and the recipient's email. */
export const TEMPLATE = 'invitation-v1';
export const MAX_REQUEST_BYTES = 1024;
const MAX_PROVIDER_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
// Explicitly reject control bytes in values that can reach email headers.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const PROVIDER_URL = 'https://api.resend.com/emails';
type DeliveryStatus = 'sending' | 'sent' | 'failed' | 'unknown';
export type Receipt = {
  id: string;
  invitation_id: string;
  status: DeliveryStatus;
  retry_at?: string | null;
  retry_until?: string | null;
  can_retry?: boolean;
  sent_at?: string | null;
  last_attempt_at?: string | null;
  error_code?: string | null;
};
export type Claim = Receipt & {
  claimed: boolean;
  lease_id?: string;
  recipient?: string;
  group_name?: string;
  group_kind?: string;
  inviter_name?: string;
  expires_at?: string;
  sender?: string;
  origin?: string;
  template?: string;
};
export type Config = { enabled: boolean; origin: string; sender: string; apiKey: string };
export type Services = {
  authenticate(token: string): Promise<string>;
  begin(args: { actor: string; group: string; tokenHash: string; sender: string; origin: string; template: string }): Promise<Claim>;
  finish(args: { delivery: string; lease: string; status: 'sent' | 'failed' | 'unknown'; providerId?: string; errorCode?: string }): Promise<Receipt>;
  fetch: typeof fetch;
  timeoutMs?: number;
};
class SafeError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
const unavailable = () => new SafeError('invitation_email_unavailable', 503);

export function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/' && !CONTROL.test(value) && !value.includes('\\');
  } catch { return false; }
}
function validEmail(value: string): boolean {
  // A single ASCII mailbox, never an address list, display name, or header.
  return value.length <= 254 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value) &&
    value.indexOf('@') <= 64;
}
export function validSender(value: string): boolean {
  if (!value || value.length > 320 || CONTROL.test(value)) return false;
  if (validEmail(value)) return true;
  const match = /^([A-Za-z0-9 ._-]{1,60}) <([^<>]+)>$/.exec(value);
  return !!match && validEmail(match[2]);
}
function configured(config: Config): boolean {
  return config.enabled && validOrigin(config.origin) && validSender(config.sender) &&
    config.apiKey.length > 0 && config.apiKey.length <= 512 && !/\s/.test(config.apiKey);
}
function safeReceipt(value: Receipt): Receipt {
  if (!value || !UUID.test(value.id) || !UUID.test(value.invitation_id) ||
    !['sending', 'sent', 'failed', 'unknown'].includes(value.status)) throw unavailable();
  const safe: Receipt = { id: value.id, invitation_id: value.invitation_id, status: value.status };
  if (typeof value.can_retry === 'boolean') safe.can_retry = value.can_retry;
  for (const field of ['retry_at', 'retry_until', 'sent_at', 'last_attempt_at'] as const) {
    if (typeof value[field] === 'string' && Number.isFinite(Date.parse(value[field]))) safe[field] = new Date(value[field]).toISOString();
  }
  // Never forward a database/provider error message, only these public codes.
  if (['provider_rejected', 'provider_rate_limit', 'provider_unavailable', 'provider_timeout',
    'delivery_unconfirmed', 'invalid_metadata'].includes(value.error_code ?? '')) {
    safe.error_code = value.error_code;
  }
  return safe;
}
function safeFailure(error: unknown): SafeError {
  if (error instanceof SafeError) return error;
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const code = /^(invitation_email_[a-z_]+)(?::|$)/.exec(message)?.[1];
  if (code === 'invitation_email_invalid_request') return new SafeError('invitation_email_invalid', 400);
  if (code === 'invitation_email_invalid_invitation') return new SafeError('invitation_email_forbidden', 403);
  const known: Record<string, number> = {
    invitation_email_unauthenticated: 401, invitation_email_forbidden: 403,
    invitation_email_invalid: 400, invitation_email_rate_limit: 429,
    invitation_email_unavailable: 503,
  };
  return code && known[code] ? new SafeError(code, known[code]) : unavailable();
}
async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!stream) throw new SafeError('invitation_email_invalid', 400);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SafeError('invitation_email_too_large', 413);
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
function displayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 320) throw unavailable();
  // Untrusted display names are body text, never HTML or header content.
  // deno-lint-ignore no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Versioned output must remain byte-for-byte stable across retries/deployments. */
export function renderInvitation(claim: Claim, token: string) {
  if (claim.template !== TEMPLATE || !TOKEN.test(token) || !validEmail(claim.recipient ?? '') ||
    !validSender(claim.sender ?? '') || !validOrigin(claim.origin ?? '') ||
    !['household', 'trip'].includes(claim.group_kind ?? '') || !claim.expires_at ||
    !Number.isFinite(Date.parse(claim.expires_at))) throw unavailable();
  const group = displayName(claim.group_name), inviter = displayName(claim.inviter_name);
  const link = `${claim.origin}/#invite=${token}`;
  const expiry = new Date(claim.expires_at).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  const scope = claim.group_kind === 'trip'
    ? 'This invitation gives you access to this trip or event only. It does not add you to a household.'
    : 'This invitation gives you access to this household. Trips and events can have their own members.';
  const subject = 'Your Pact invitation';
  const intro = `${inviter} invited you to join ${group} on Pact.`;
  const account = `Sign in with Google using ${claim.recipient}.`;
  const text = `Hi there,\n\n${intro}\nKeep shared expenses simple, together.\n\nJoin ${group}:\n${link}\n\n${account}\n${scope}\n\nYour personal link expires on ${expiry}. If you were not expecting this invitation, you can ignore this email.\n\nSee you on Pact.\n`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f5f6f0;color:#1b211c;font-family:Arial,sans-serif"><main style="max-width:520px;margin:32px auto;padding:32px;background:#fff;border-radius:20px"><p style="font-size:26px;font-weight:700;margin:0 0 28px">p. Pact</p><h1 style="font-size:26px;line-height:1.2">Good things, shared.</h1><p style="line-height:1.6">${escapeHtml(intro)}</p><p style="line-height:1.6">Keep shared expenses simple, together.</p><p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#d4f878;color:#1b211c;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:700">Join ${escapeHtml(group)}</a></p><p style="line-height:1.6">${escapeHtml(account)}</p><p style="font-size:14px;line-height:1.6">${escapeHtml(scope)}</p><p style="font-size:13px;line-height:1.6;color:#596256">Your personal link expires on ${expiry}. If you were not expecting this invitation, you can ignore this email.</p><p style="line-height:1.6">See you on Pact.</p></main></body></html>`;
  return { from: claim.sender!, to: [claim.recipient!], subject, html, text };
}

export function invitationEmailHandler(config: Config, services: Services) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const allowed = validOrigin(config.origin) && origin === config.origin;
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin, Authorization',
    };
    if (allowed) Object.assign(headers, {
      'Access-Control-Allow-Origin': config.origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...headers, 'Content-Type': 'application/json' },
    });
    try {
      if (origin && !allowed) throw new SafeError('invitation_email_forbidden', 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') throw new SafeError('invitation_email_method', 405);
      // Tokens belong in the JSON body, never a URL that proxies may log.
      if (new URL(request.url).search) throw new SafeError('invitation_email_invalid', 400);
      if (!configured(config)) throw unavailable();
      const jwt = /^Bearer ([^\s]{1,8192})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!jwt) throw new SafeError('invitation_email_unauthenticated', 401);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
        throw new SafeError('invitation_email_invalid', 400);
      }
      const length = request.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
        throw new SafeError('invitation_email_too_large', 413);
      }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request.body, MAX_REQUEST_BYTES))); }
      catch (error) { if (error instanceof SafeError) throw error; throw new SafeError('invitation_email_invalid', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'group_id,token' ||
        !('group_id' in body) || typeof body.group_id !== 'string' || !UUID.test(body.group_id) ||
        !('token' in body) || typeof body.token !== 'string' || !TOKEN.test(body.token)) {
        throw new SafeError('invitation_email_invalid', 400);
      }
      const actor = await services.authenticate(jwt);
      if (!UUID.test(actor)) throw new SafeError('invitation_email_unauthenticated', 401);
      const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.token))),
        value => value.toString(16).padStart(2, '0')).join('');
      const claim = await services.begin({ actor, group: body.group_id.toLowerCase(), tokenHash,
        sender: config.sender, origin: config.origin, template: TEMPLATE });
      const receipt = safeReceipt(claim);
      if (!claim.claimed) return json(receipt, ['sending', 'unknown'].includes(receipt.status) ? 202 : 200);
      if (claim.status !== 'sending' || !UUID.test(claim.lease_id ?? '')) throw unavailable();
      let outcome: 'sent' | 'failed' | 'unknown' = 'unknown';
      let errorCode = 'delivery_unconfirmed', providerId: string | undefined;
      let message: ReturnType<typeof renderInvitation> | undefined;
      try { message = renderInvitation(claim, body.token); }
      catch { outcome = 'failed'; errorCode = 'invalid_metadata'; }
      if (message) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), services.timeoutMs ?? 12_000);
        try {
          const response = await services.fetch(PROVIDER_URL, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
              'Idempotency-Key': `pact-invitation/${claim.id}` },
            body: JSON.stringify(message),
          });
          if (response.ok) {
            const provider = JSON.parse(new TextDecoder().decode(await readBounded(response.body, MAX_PROVIDER_BYTES)));
            if (provider && typeof provider.id === 'string' && UUID.test(provider.id)) {
              outcome = 'sent'; providerId = provider.id; errorCode = '';
            }
          } else {
            await response.body?.cancel();
            // A transient/ambiguous response might have followed acceptance.
            // Keep the same idempotency key, never generate a replacement here.
            if (response.status === 429) errorCode = 'provider_rate_limit';
            else if ([400, 401, 403, 404, 422].includes(response.status)) { outcome = 'failed'; errorCode = 'provider_rejected'; }
            else errorCode = 'provider_unavailable';
          }
        } catch {
          errorCode = controller.signal.aborted ? 'provider_timeout' : 'delivery_unconfirmed';
          // Unknown is intentional. Never log credentials, link, email or provider bodies.
        }
        finally { clearTimeout(timer); }
      }
      try {
        const finished = safeReceipt(await services.finish({ delivery: claim.id, lease: claim.lease_id!,
          status: outcome, providerId, errorCode: errorCode || undefined }));
        if (finished.id !== claim.id || finished.invitation_id !== claim.invitation_id ||
          (finished.status === 'sent' && outcome !== 'sent')) throw unavailable();
        return json(finished, ['sending', 'unknown'].includes(finished.status) ? 202 : 200);
      } catch {
        // Receipt persistence may have succeeded. Retrying the same invitation
        // can reconcile it without a duplicate provider send.
        return json({ ...receipt, status: 'unknown', can_retry: false,
          retry_at: receipt.retry_at ?? new Date(Date.now() + 60_000).toISOString(),
          error_code: 'delivery_unconfirmed' }, 202);
      }
    } catch (error) {
      const safe = safeFailure(error);
      return json({ status: safe.status === 503 ? 'unavailable' : 'failed', error: safe.code }, safe.status);
    }
  };
}

// The fetch mock deliberately returns resolved responses without real I/O.
// deno-lint-ignore-file require-await
import assert from 'node:assert/strict';

const env = {
  SUPABASE_URL: 'https://synthetic.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'synthetic-service-test-only' }),
  INVITATION_EMAIL_ENABLED: 'true', PACT_APP_ORIGIN: 'https://pact.example.com',
  PACT_INVITATION_FROM: 'Pact <invites@example.com>', RESEND_API_KEY: 'synthetic-test-only-key',
};
const originalEnv = new Map(Object.keys(env).map(key => [key, Deno.env.get(key)]));
for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
const originalFetch = globalThis.fetch;
const actor = '11111111-1111-4111-8111-111111111111', group = '22222222-2222-4222-8222-222222222222';
const delivery = '33333333-3333-4333-8333-333333333333', invitation = '44444444-4444-4444-8444-444444444444';
const lease = '55555555-5555-4555-8555-555555555555', provider = '66666666-6666-4666-8666-666666666666';
const token = 'cd'.repeat(32);
let scenario = 'good';
const rpcBodies: Record<string, unknown>[] = [];
let sends = 0, authCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === `${env.SUPABASE_URL}/auth/v1/user`) {
    authCalls++;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-user-jwt');
    if (scenario === 'revoked') return Response.json({ message: 'revoked' }, { status: 401 });
    return Response.json({ id: actor, email_confirmed_at: scenario === 'unconfirmed' ? null : '2030-01-01T00:00:00Z',
      app_metadata: { providers: scenario === 'metadata-forgery' ? ['email'] : ['google'] },
      user_metadata: { id: group, role: 'organiser', providers: ['google'] } });
  }
  if (url.endsWith('/rest/v1/rpc/begin_invitation_email')) {
    const body = JSON.parse(String(init?.body)); rpcBodies.push(body);
    assert.equal(body.p_actor, actor); assert.equal(body.p_group, group);
    assert.ok(body.p_token_hash !== token && /^[a-f0-9]{64}$/.test(body.p_token_hash));
    assert.ok(!JSON.stringify(body).includes(token));
    return Response.json({ id: delivery, invitation_id: invitation, status: 'sending', claimed: true, lease_id: lease,
      recipient: 'friend@example.com', group_name: 'Weekend away', group_kind: 'trip', inviter_name: 'Alex',
      expires_at: '2030-01-08T00:00:00Z', sender: env.PACT_INVITATION_FROM, origin: env.PACT_APP_ORIGIN, template: 'invitation-v1' });
  }
  if (url === 'https://api.resend.com/emails') {
    sends++;
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), `pact-invitation/${delivery}`);
    return Response.json({ id: provider });
  }
  if (url.endsWith('/rest/v1/rpc/finish_invitation_email')) {
    const body = JSON.parse(String(init?.body)); rpcBodies.push(body);
    assert.deepEqual(body, { p_delivery: delivery, p_lease: lease, p_status: 'sent', p_provider_id: provider, p_error_code: null });
    return Response.json({ id: delivery, invitation_id: invitation, status: 'sent', can_retry: false });
  }
  throw new Error('Unexpected test request');
};
Object.defineProperty(Deno, 'serve', { value: (value: typeof handler) => { handler = value; }, configurable: true });
try { await import('./index.ts'); }
finally {
  Object.defineProperty(Deno, 'serve', { value: serve, configurable: true });
  for (const [key, value] of originalEnv) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
}

Deno.test('entrypoint validates Google user with Auth.getUser and uses only verified ID in service RPC', async () => {
  try {
    for (scenario of ['revoked', 'unconfirmed', 'metadata-forgery', 'good']) {
      const response = await handler(new Request('https://worker.example.com', { method: 'POST',
        headers: { Origin: env.PACT_APP_ORIGIN, Authorization: 'Bearer synthetic-user-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: group, token }) }));
      assert.equal(response.status, scenario === 'good' ? 200 : 401);
    }
    assert.equal(authCalls, 4); assert.equal(sends, 1); assert.equal(rpcBodies.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

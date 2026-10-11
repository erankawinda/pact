import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import { equalSecret, isPushEndpoint, retrySeconds } from './delivery.ts';

const secret = 'synthetic-test-dispatch-key-not-a-real-credential';
const vapid = webPush.generateVAPIDKeys(), browserKey = createECDH('prime256v1');
browserKey.generateKeys();
Deno.env.set('PACT_DISPATCH_SECRET', secret);
Deno.env.set('SUPABASE_URL', 'https://synthetic.supabase.co');
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_synthetic_test_only' }));
Deno.env.set('VAPID_PUBLIC_KEY', vapid.publicKey);
Deno.env.set('VAPID_PRIVATE_KEY', vapid.privateKey);
Deno.env.set('VAPID_SUBJECT', 'https://example.com/pact');
let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
Object.defineProperty(Deno, 'serve', { value: (value: typeof handler) => { handler = value; }, configurable: true });
await import('./index.ts');
Object.defineProperty(Deno, 'serve', { value: serve, configurable: true });

Deno.test('only reviewed provider origins and path forms pass; retry policy and secret checks are bounded', async () => {
  for (const url of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/v2/test', 'https://web.push.apple.com/token']) assert.equal(isPushEndpoint(url), true);
  for (const url of ['http://fcm.googleapis.com/test', 'https://fcm.googleapis.com.evil.test/path', 'https://fcm.googleapis.com:443/path', 'https://user@fcm.googleapis.com/path', 'https://localhost/path', 'https://a.b.push.apple.com/path', 'https://fcm.googleapis.com/path?q=x', 'https://fcm.googleapis.com/path#x', 'https://fcm.googleapis.com/path\\a']) assert.equal(isPushEndpoint(url), false, url);
  assert.equal(retrySeconds(null, 1), 30); assert.equal(retrySeconds(null, 8), 3840);
  assert.equal(retrySeconds('999999', 1), 86400); assert.equal(retrySeconds('0', 1), 1);
  assert.equal(retrySeconds('Thu, 01 Jan 1970 00:02:00 GMT', 1, 0), 120);
  assert.equal(await equalSecret(secret, secret), true); assert.equal(await equalSecret(secret+'x', secret), false);
});
Deno.test('scheduler authentication fails before any database or provider request', async () => {
  const response = await handler(new Request('https://example.com/worker', { method: 'POST' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

for (const status of [201, 410, 429, 503, 400]) {
  Deno.test(`provider ${status} records only the bounded outcome without exposing endpoint details`, async () => {
    const original = globalThis.fetch;
    const acknowledgments: Record<string, unknown>[] = [];
    let deliveries = 0;
    const id = '11111111-1111-4111-8111-111111111111', lease = '22222222-2222-4222-8222-222222222222';
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/rpc/claim_notification_deliveries')) return Response.json([{id, lease_token: lease}]);
      if (url.includes('/rpc/get_notification_delivery')) return Response.json({id, endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-private-endpoint', p256dh:browserKey.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url'),binding:'33333333-3333-4333-8333-333333333333',category:'expenses',tone:'friendly',attempts:1,expires_at:new Date(Date.now()+60000).toISOString()});
      if (url.includes('/rpc/finish_notification_delivery')) {acknowledgments.push(JSON.parse(String(init?.body)));return Response.json(true);}
      if (url.startsWith('https://fcm.googleapis.com/')) {
        deliveries++; assert.equal(init?.redirect,'error');assert.ok(init?.body instanceof Uint8Array);
        const headers = new Headers(init?.headers); assert.equal(headers.get('content-encoding'),'aes128gcm');assert.ok(headers.get('authorization')?.startsWith('vapid '));
        assert.ok(!new TextDecoder().decode(init?.body as Uint8Array).includes('expenses'),'payload is encrypted');
        return new Response('provider-private-detail', {status, headers:{'Retry-After':'120'}});
      }
      throw new Error('Unexpected request');
    };
    try {
      const response=await handler(new Request('https://example.com/worker',{method:'POST',headers:{'x-pact-dispatch-key':secret}}));
      assert.equal(response.status,200);assert.equal(deliveries,1);
      assert.equal(acknowledgments.length,1);assert.equal(acknowledgments[0].p_outcome,status===201?'sent':status===410?'gone':status===429||status===503?'retry':'dead');
      if(status===429||status===503)assert.equal(acknowledgments[0].p_retry_seconds,120);
      const body=await response.text();assert.ok(!body.includes('private-detail')&&!body.includes('endpoint')&&!body.includes('33333333'));
    } finally {globalThis.fetch=original;}
  });
}

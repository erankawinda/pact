// Service mocks deliberately implement async interfaces without real I/O.
// deno-lint-ignore-file require-await
import assert from 'node:assert/strict';
import { invitationEmailHandler, renderInvitation, validOrigin, validSender, type Claim, type Config, type Services } from './handler.ts';

const actor = '11111111-1111-4111-8111-111111111111';
const group = '22222222-2222-4222-8222-222222222222';
const delivery = '33333333-3333-4333-8333-333333333333';
const invitation = '44444444-4444-4444-8444-444444444444';
const lease = '55555555-5555-4555-8555-555555555555';
const provider = '66666666-6666-4666-8666-666666666666';
const token = 'ab'.repeat(32);
const config: Config = { enabled: true, origin: 'https://pact.example.com', sender: 'Pact <invites@example.com>', apiKey: 'synthetic-test-only-key' };
const claim: Claim = {
  id: delivery, invitation_id: invitation, status: 'sending', claimed: true, lease_id: lease,
  recipient: 'friend@example.com', group_name: 'Weekend away', group_kind: 'trip', inviter_name: 'Alex',
  expires_at: '2030-01-08T10:00:00Z', sender: config.sender, origin: config.origin, template: 'invitation-v1',
  retry_at: '2030-01-01T10:01:00Z', retry_until: '2030-01-02T09:00:00Z', can_retry: false,
};
function request(body: unknown = { group_id: group, token }, overrides: RequestInit = {}, url = 'https://worker.example.com/invitation-email') {
  return new Request(url, { method: 'POST', headers: {
    Origin: config.origin, Authorization: 'Bearer synthetic-user-jwt', 'Content-Type': 'application/json',
  }, body: JSON.stringify(body), ...overrides });
}
function harness(overrides: Partial<Services> = {}, settings: Config = config) {
  const calls: { auth: string[]; begin: unknown[]; finish: Parameters<Services['finish']>[0][]; fetch: {url: string; init?: RequestInit}[] } = { auth: [], begin: [], finish: [], fetch: [] };
  const services: Services = {
    async authenticate(jwt) { calls.auth.push(jwt); return actor; },
    async begin(args) { calls.begin.push(args); return { ...claim }; },
    async finish(args) {
      calls.finish.push(args);
      return { id: delivery, invitation_id: invitation, status: args.status, can_retry: args.status === 'unknown',
        error_code: args.errorCode, retry_at: claim.retry_at, retry_until: claim.retry_until };
    },
    async fetch(input, init) { calls.fetch.push({ url: String(input), init }); return Response.json({ id: provider }); },
    ...overrides,
  };
  return { handler: invitationEmailHandler(settings, services), calls };
}

Deno.test('sending binds the verified actor and token hash; provider acceptance is persisted before sent', async () => {
  const { handler, calls } = harness();
  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'sent'); assert.equal(body.id, delivery); assert.equal(body.can_retry, false);
  assert.deepEqual(calls.auth, ['synthetic-user-jwt']);
  const hashed = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), x => x.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(calls.begin, [{ actor, group, tokenHash: hashed, sender: config.sender, origin: config.origin, template: 'invitation-v1' }]);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, 'https://api.resend.com/emails');
  const init = calls.fetch[0].init!;
  assert.equal(init.redirect, 'error');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('Idempotency-Key'), `pact-invitation/${delivery}`);
  const mail = JSON.parse(String(init.body));
  assert.deepEqual(mail.to, ['friend@example.com']);
  assert.ok(mail.text.includes(`${config.origin}/#invite=${token}`));
  assert.ok(mail.text.includes('Sign in with Google using friend@example.com.'));
  assert.ok(mail.text.includes('trip or event only'));
  assert.deepEqual(calls.finish, [{ delivery, lease, status: 'sent', providerId: provider, errorCode: undefined }]);
  const publicBody = JSON.stringify(body);
  for (const privateValue of [token, provider, claim.recipient!, claim.group_name!, config.apiKey]) assert.ok(!publicBody.includes(privateValue));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), config.origin);
});

Deno.test('feature is opt in and validates all server configuration before any side effect', async () => {
  for (const settings of [{ ...config, enabled: false }, { ...config, sender: '' }, { ...config, apiKey: '' },
    { ...config, apiKey: 'secret\r\nheader' }, { ...config, origin: 'https://pact.example.com/path' }]) {
    const { handler, calls } = harness({}, settings);
    const response = await handler(request(undefined, { headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' } }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable', error: 'invitation_email_unavailable' });
    assert.deepEqual(calls, { auth: [], begin: [], finish: [], fetch: [] });
  }
});

Deno.test('CORS is exact, OPTIONS is inert, and only POST can send', async () => {
  const { handler, calls } = harness();
  const preflight = await handler(new Request('https://worker.example.com', { method: 'OPTIONS', headers: { Origin: config.origin } }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), config.origin);
  const forbidden = await handler(request(undefined, { headers: { Origin: 'https://pact.example.com.attacker.test' } }));
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
  const get = await handler(new Request('https://worker.example.com'));
  assert.equal(get.status, 405); assert.equal(calls.fetch.length, 0); assert.equal(calls.auth.length, 0);
});

Deno.test('missing auth, forged metadata and invalid input cannot reach the provider', async () => {
  const attempts: [Request, number][] = [
    [request(undefined, { headers: { 'Content-Type': 'application/json' } }), 401],
    [request({ group_id: group, token, email: 'victim@example.com' }), 400],
    [request({ group_id: group, token, actor }), 400],
    [request({ group_id: 'not-a-group', token }), 400],
    [request({ group_id: group, token: token.toUpperCase() }), 400],
    [request({}, {}, 'https://worker.example.com?token=should-never-be-here'), 400],
    [request(undefined, { headers: { Authorization: 'Bearer jwt', 'Content-Type': 'text/plain' } }), 400],
    [request(undefined, { body: '{broken' }), 400],
    [request(undefined, { body: new Uint8Array([0xff]) }), 400],
    [request(undefined, { body: 'a'.repeat(1025) }), 413],
    [request(undefined, { headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json', 'Content-Length': '1025' } }), 413],
  ];
  for (const [attempt, expected] of attempts) {
    const { handler, calls } = harness(); const response = await handler(attempt);
    assert.equal(response.status, expected); assert.equal(calls.fetch.length, 0); assert.equal(calls.begin.length, 0);
  }
});

Deno.test('Auth and organizer failures are generic and do not forward private error details', async () => {
  for (const [overrides, expected] of [
    [{ authenticate: async () => { throw new Error('invitation_email_unauthenticated: private detail'); } }, 401],
    [{ begin: async () => { throw new Error('invitation_email_forbidden: friend@example.com'); } }, 403],
    [{ begin: async () => { throw new Error('invitation_email_rate_limit: private detail'); } }, 429],
    [{ begin: async () => { throw new Error(`unexpected ${token}`); } }, 503],
  ] as [Partial<Services>, number][]) {
    const { handler, calls } = harness(overrides); const response = await handler(request());
    assert.equal(response.status, expected); assert.equal(calls.fetch.length, 0);
    const body = await response.text(); assert.ok(!body.includes(token) && !body.includes('friend@example.com') && !body.includes('private detail'));
  }
});

Deno.test('existing sent receipt, active lease and terminal failed state never cause a duplicate provider request', async () => {
  for (const status of ['sent', 'sending', 'failed'] as const) {
    const { handler, calls } = harness({ begin: async () => ({ ...claim, status, claimed: false }) });
    const response = await handler(request());
    assert.equal((await response.json()).status, status); assert.equal(calls.fetch.length, 0); assert.equal(calls.finish.length, 0);
  }
});

for (const [status, expected, code] of [[400, 'failed', 'provider_rejected'], [401, 'failed', 'provider_rejected'],
  [403, 'failed', 'provider_rejected'], [422, 'failed', 'provider_rejected'], [429, 'unknown', 'provider_rate_limit'],
  [500, 'unknown', 'provider_unavailable'], [409, 'unknown', 'provider_unavailable']] as const) {
  Deno.test(`provider ${status} is recorded as ${expected} without exposing the response body`, async () => {
    const { handler, calls } = harness({ fetch: async () => new Response(`private detail ${token}`, { status }) });
    const response = await handler(request()); const body = await response.json();
    assert.equal(body.status, expected); assert.equal(calls.finish[0].status, expected); assert.equal(calls.finish[0].errorCode, code);
    assert.ok(!JSON.stringify(body).includes(token)); assert.ok(!JSON.stringify(calls.finish).includes('private detail'));
  });
}

Deno.test('timeout is unknown and remains eligible for same-key reconciliation', async () => {
  const { handler, calls } = harness({ timeoutMs: 1, fetch: (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error(`private timeout ${token}`)), { once: true });
  }) });
  const response = await handler(request()); assert.equal(response.status, 202);
  const body = await response.json(); assert.equal(body.status, 'unknown'); assert.equal(body.can_retry, true);
  assert.equal(calls.finish[0].errorCode, 'provider_timeout');
});

Deno.test('malformed success response or lost receipt is never reported as sent', async () => {
  for (const reply of ['{}', '{"id":"invalid"}', 'a'.repeat(4097)]) {
    const { handler, calls } = harness({ fetch: async () => new Response(reply) });
    const response = await handler(request()); assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'unknown'); assert.equal(calls.finish[0].status, 'unknown');
  }
  for (const finish of [async () => { throw new Error('lost response'); }, async () => ({ id: actor, invitation_id: invitation, status: 'sent' as const })]) {
    const { handler } = harness({ finish }); const response = await handler(request());
    const body = await response.json(); assert.equal(response.status, 202); assert.equal(body.status, 'unknown');
    assert.equal(body.can_retry, false); assert.ok(body.retry_at);
  }
});

Deno.test('retry payload is stable despite changed environment sender/origin', async () => {
  const first = harness(), second = harness({}, { ...config, sender: 'New <new@example.com>', origin: 'https://new.example.com' });
  await first.handler(request());
  await second.handler(request(undefined, { headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json', Origin: 'https://new.example.com' } }));
  assert.equal(first.calls.fetch[0].init!.body, second.calls.fetch[0].init!.body);
  assert.equal(new Headers(first.calls.fetch[0].init!.headers).get('Idempotency-Key'), new Headers(second.calls.fetch[0].init!.headers).get('Idempotency-Key'));
});

Deno.test('HTML and header injection are escaped or rejected; scope remains explicit', () => {
  for (const value of ['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user@example.com', 'https://example.com?x=1', 'https://example.com#x', 'https://example.com\\evil', 'https://example.com\n']) assert.equal(validOrigin(value), false);
  for (const value of ['a@example.com\r\nBcc: b@example.com', 'a@example.com,b@example.com', 'Pact <a@example.com>\n']) assert.equal(validSender(value), false);
  const mail = renderInvitation({ ...claim, group_name: '<img src=x onerror=alert(1)>\r\nBcc: victim@example.com', inviter_name: 'Alex & Casey' }, token);
  assert.ok(!mail.html.includes('<img')); assert.ok(mail.html.includes('&lt;img')); assert.ok(mail.html.includes('Alex &amp; Casey'));
  assert.equal(mail.subject, 'Your Pact invitation'); assert.ok(!mail.subject.includes('\n'));
  assert.ok(renderInvitation({ ...claim, group_kind: 'household' }, token).text.includes('access to this household'));
});

Deno.test('unsafe frozen metadata fails before provider; no secret or contact logging occurs', async () => {
  const logs: unknown[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => { logs.push(args); };
  try {
    for (const unsafe of [{ recipient: 'a@example.com\r\nBcc: b@example.com' }, { origin: 'https://evil.example/path' },
      { template: 'unknown-v2' }, { sender: 'bad' }, { expires_at: 'invalid' }, { group_kind: 'admin' }]) {
      const { handler, calls } = harness({ begin: async () => ({ ...claim, ...unsafe }) });
      const response = await handler(request()); assert.equal((await response.json()).status, 'failed');
      assert.equal(calls.fetch.length, 0); assert.equal(calls.finish[0].errorCode, 'invalid_metadata');
    }
    await harness({ fetch: async () => { throw new Error(`private ${token} ${config.apiKey}`); } }).handler(request());
    assert.deepEqual(logs, []);
  } finally { Object.assign(console, originals); }
});

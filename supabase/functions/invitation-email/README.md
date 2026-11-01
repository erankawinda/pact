# Invitation email

This optional worker emails an existing Pact invitation to its bound Google
email address. It does not create accounts or add members. Accepting the
invitation still requires the matching verified Google account and the existing
group access checks.

## Server configuration

The function is disabled unless `INVITATION_EMAIL_ENABLED` is exactly `true`.
Save these values as **Edge Function secrets**, never as frontend configuration,
source files, screenshots, or GitHub Actions output:

| Name | Value |
| --- | --- |
| `INVITATION_EMAIL_ENABLED` | `true` only after sender and staging validation |
| `RESEND_API_KEY` | A server-only Resend key restricted to sending from the verified sender domain |
| `PACT_INVITATION_FROM` | One verified address, for example `Pact <invites@example.com>` |
| `PACT_APP_ORIGIN` | Exact HTTPS app origin, for example `https://pact.example.com`, with no trailing slash, path, query, credentials, or fragment |

The platform supplies `SUPABASE_URL` and either
`SUPABASE_SECRET_KEYS.default` or legacy `SUPABASE_SERVICE_ROLE_KEY`. The worker
validates the caller with Auth `getUser`; it never trusts `user_metadata` for
permissions. Keep platform JWT verification enabled for this function.

Apply the invitation-email delivery migration before deploying the worker.
Deploy each environment with its own sender/provider configuration and exact
origin. A missing or invalid configuration returns a safe `503`; it cannot send.
Do not enable the frontend email option until the configured worker has passed
an authorized staging send and read-back check. Link creation and manual sharing
remain available without a mail provider.

## Client contract

Call `POST /functions/v1/invitation-email` with the current user's bearer JWT and
JSON `{ "group_id": "<group UUID>", "token": "<64-character invitation token>" }`.
No client-supplied recipient, sender, actor, or message is accepted. Send the token
only in the body; never add it to a request URL or logs. Browser CORS permits
only the configured app origin.

Successful HTTP responses contain `id`, `invitation_id`, `status`, and available
`can_retry`, `retry_at`, `retry_until`, `sent_at`, `last_attempt_at`, `error_code`.
The worker returns no address, provider ID, token, or database error text.

| Status | Meaning |
| --- | --- |
| `sent` (HTTP 200) | Resend accepted the message and Pact confirmed the durable receipt. This does **not** confirm inbox delivery or reading. |
| `sending` (HTTP 202) | Another request owns the delivery lease; check status. |
| `unknown` (HTTP 202) | Acceptance or receipt could not be confirmed. Check status and retry the **same token** only when allowed. |
| `failed` (HTTP 200) | A definite terminal rejection or invalid frozen metadata; automatic retry is disabled. |
| `unavailable` (HTTP 503) | Service is not configured or could not authorize/claim safely; no successful send is claimed. |

Other HTTP errors are generic: 400 invalid request, 401 sign-in required, 403
invitation/access unavailable, 405 method, 413 body too large, 429 database rate
limit. Error text contains no provider response or personal information. The
authenticated `get_invitation_email_status` RPC is the source of persistent
organizer-visible status, including after a page refresh.

## Retry and privacy boundaries

The database rechecks organizer access and the invitation, claims a 60-second
lease, limits new sends, and freezes the message metadata on first attempt. Only
the service can begin or finish delivery. A raw token is hashed in the worker
before RPC calls; no raw token, bearer JWT, message body, or provider error is
stored in the delivery table or application logs.

Resend receives the bound address, invitation link, group name and inviter name
to deliver this transactional email. Use a reviewed provider account and its
appropriate retention settings. The function makes exactly one HTTP request per
claimed attempt, to `https://api.resend.com/emails`, with redirects disabled and
a 12-second timeout. It never falls back to another recipient or endpoint.

Every retry uses the same delivery UUID in `Idempotency-Key` and the same frozen
message, including sender/origin after configuration changes. `invitation-v1`
rendering is immutable: introduce a new version for future template changes;
do not change the output for an existing delivery. Resend documents a 24-hour
idempotency window; the database stops retries after 23 hours, invitation expiry,
or four attempts, whichever comes first. It never retries a known `sent` result.

Timeouts, transient provider failures and lost receipt responses remain
`unknown`. Reissuing a different invitation is not a safe substitute for
reconciling an unknown send, because it creates a new provider idempotency key.
Existing invitation revocation and expiry still make old links unusable.

There is no background queue or webhook delivery claim in this version. Retries
require the original token still held by the inviting page. After reload, the
organizer can see status and use the existing personal link they retained; the
server cannot recover a hash-only token to resend it.

## Verify

From this folder:

```sh
deno check index.ts handler.ts
deno test --allow-env handler.test.ts index.test.ts
```

Tests use synthetic identities and mocked services. They run without network
permission and send no email. Coverage includes server-side identity binding,
configuration fail-closed behavior, exact CORS, size limits, header/HTML safety,
provider outcomes, lost receipts, immutable retry payloads and absence of secret
logging. Hosted provider acceptance, inbox delivery and production configuration
must be checked separately before enabling the feature.

References: [Supabase Auth headers](https://supabase.com/docs/guides/functions/auth-headers),
[Resend send API](https://resend.com/docs/api-reference/emails/send-email),
[Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

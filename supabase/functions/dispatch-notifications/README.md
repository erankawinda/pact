# Transaction notification dispatcher

A scheduled, server-only worker sends encrypted Web Push messages from Pact’s private transactional outbox. It never accepts a browser’s financial event or notification text. The database commits the event and derives its recipients; the worker rechecks the active session, membership, preferences and installation binding immediately before delivery.

## Deploy to staging first

1. Apply `20261011083914_transaction_notifications.sql` using the normal migration review process.
2. Set these **Edge Function secrets**, outside Git and the frontend build:
   - `PACT_DISPATCH_SECRET`: at least 32 random bytes, encoded as base64url.
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: one persistent P-256 VAPID pair, base64url encoded. The public key is the 65-byte uncompressed point; the private key is 32 bytes.
   - `VAPID_SUBJECT`: a real HTTPS project/contact URL or `mailto:` contact; do not use localhost.
   - Supabase supplies `SUPABASE_URL` and `SUPABASE_SECRET_KEYS`. The worker reads the dictionary’s `default` secret key, with `SUPABASE_SERVICE_ROLE_KEY` fallback for older projects. Never put either server key into Vite variables.
3. Check and deploy the function:
   ```sh
   deno test --allow-env --config supabase/functions/dispatch-notifications/deno.json supabase/functions/dispatch-notifications/dispatch.test.ts
   deno check --config supabase/functions/dispatch-notifications/deno.json supabase/functions/dispatch-notifications/index.ts
   supabase functions deploy dispatch-notifications --project-ref YOUR_STAGING_PROJECT_REF --no-verify-jwt
   ```
   The gateway JWT check is disabled because this endpoint uses its own scheduler secret, not a user JWT. Every request still requires the matching `x-pact-dispatch-key` header. Deploying without either authentication layer is unsafe.
4. Enable the Supabase Cron, pg_net and Vault integrations. Privately create Vault secrets named `pact_notification_dispatch_secret` (same value as `PACT_DISPATCH_SECRET`) and `pact_notification_dispatch_url` (the staging function HTTPS URL). Use the Dashboard’s private fields or a non-versioned administrative session; do not save real values in SQL files, shell history or the repository.
5. Review and run `schedule.sql` on staging. The job invokes the worker once per minute. The schedule contains only Vault names, so rotating its key requires changing both the Edge secret and Vault value.
6. Build the staging frontend with `VITE_WEB_PUSH_PUBLIC_KEY` equal to `VAPID_PUBLIC_KEY`, and `VITE_NOTIFICATIONS_ENABLED=true`. The public VAPID key may be published; the private key and scheduler secret may not.
7. Complete the staging acceptance checks below before enabling production. Separate staging and production VAPID pairs and dispatch tokens are recommended. Changing a VAPID pair requires users to reset and enable device notifications again.

## Acceptance checks

- On a supported phone, explicitly enable notifications from Account, send one test, and confirm it arrives when Pact is closed. iPhone/iPad require iOS/iPadOS 16.4+ and the installed Home Screen app. Permission must follow a user tap. Focus or OS/browser policy may delay delivery.
- Have another signed-in account create an expense involving the test recipient. Verify that recipient receives one generic alert and the actor and uninvolved housemate receive none. Correct the expense’s participants and verify each old/new participant gets at most one alert for the correction.
- Verify the categories and friendly/brief tone, repayment directions, refund updates, a trip with restricted membership, and the authenticated destination when tapping an alert.
- Disable a category or revoke membership/session before dispatch; the queued delivery must be skipped. Sign out or switch account, including while a permission prompt is pending; an old binding must never display or open a notification.
- Verify an unavailable endpoint is revoked, provider throttling/temporary failures retry, wrong scheduler secret gets HTTP 401, and ordinary authenticated users cannot call worker RPCs or read private endpoint tables.

A successful HTTP response from a push provider means accepted for delivery, not proof the phone displayed it. The private outbox retries up to eight attempts for no longer than 24 hours (10 minutes for a test). A worker crash after provider acceptance can repeat delivery; the stable Web Push topic and notification tag reduce duplicates but do not provide exactly-once delivery. No fetch/offline cache is installed by the service worker.

## Operations and privacy

The function returns aggregate counts only. It does not log endpoints, encryption keys, payloads, raw provider responses, names or transaction amounts. The encrypted payload contains a random outbox identifier, a random installation binding, category and tone. The service worker builds fixed generic lock-screen text locally; opening Pact still requires the authenticated recipient and current membership.

The worker accepts only the documented Apple, Google FCM and Mozilla Web Push hostnames and refuses redirects. Unsupported push providers cannot register until explicitly reviewed and added to both allowlists. Twelve deliveries per run, with four concurrent requests and ten-second network timeouts, bound workload within the two-minute lease. Monitor queue counts and oldest pending age privately if usage exceeds this small-household capacity.

The dispatch claim prunes terminal delivery history older than seven days and revoked subscriptions older than thirty days. Notification links older than the retained history become unavailable; financial records are unaffected. To pause dispatch, disable the Cron job. Keep the database outbox installed and turn off the frontend feature flag if rolling back the UI.

Official references: [Web Push library](https://github.com/web-push-libs/web-push), [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions), [Supabase API key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys), [WebKit iOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

# Development setup and deployment

Pact is a static React application backed by Supabase Auth, PostgreSQL and Realtime. Optional private photos and notifications also use Storage and Edge Functions; notifications require Vault, Cron and pg_net. Use your own development project and synthetic household records when working on a fork. This repository contains no configured hosted environment or real household data.

## 1. Install and check the source

Use Node.js 22.12 or later and npm. From the repository root:

```sh
npm ci
npm run check
```

`check` runs the public privacy gate, Node test suite, TypeScript validation and a Vite build. These checks use disposable local database fixtures and do not require a hosted Supabase project. A successful build without environment variables does not create a connected app.

Run `npm run test:browser`, `npm run test:privacy-browser` and `npm run test:notifications-browser` for the three isolated browser/accessibility suites. See [qa/README.md](../qa/README.md) for Chromium installation, coverage and generated artifacts. The notification worker also has [separate Deno checks](../supabase/functions/dispatch-notifications/README.md#deploy-to-staging-first).

## 2. Create a development backend

Create a new, empty Supabase project. The SQL expects the Auth schema and roles supplied by Supabase; it is not an independent plain-PostgreSQL installer.

In that project's SQL Editor, run the full contents of each file once, in this order:

1. [`20261004024901_foundation.sql`](../supabase/migrations/20261004024901_foundation.sql)
2. [`20261004025331_relationship_indexes.sql`](../supabase/migrations/20261004025331_relationship_indexes.sql)
3. [`20261005071001_household_workflows.sql`](../supabase/migrations/20261005071001_household_workflows.sql)
4. [`20261006062916_editable_profiles.sql`](../supabase/migrations/20261006062916_editable_profiles.sql) — adds the own-name update operation.
5. [`20261011030705_received_repayments.sql`](../supabase/migrations/20261011030705_received_repayments.sql) — adds recipient recording, recorder attribution and repayment duplicate guards.
6. [`20261011035030_recipient_payment_preferences.sql`](../supabase/migrations/20261011035030_recipient_payment_preferences.sql) — adds recipient-owned approval preferences and automatic settlement by default.
7. [`20261011083914_transaction_notifications.sql`](../supabase/migrations/20261011083914_transaction_notifications.sql) — adds private preferences, session-bound device subscriptions and the transaction outbox.
8. [`20261011083917_private_profile_photos.sql`](../supabase/migrations/20261011083917_private_profile_photos.sql) — adds the private photo bucket and server-only lifecycle operations.
9. [`20261011085233_notification_relationship_indexes.sql`](../supabase/migrations/20261011085233_notification_relationship_indexes.sql) — adds indexes for notification cleanup and device revocation.

Stop if any file fails. These are versioned migrations, not scripts to rerun on an existing schema. They create tables, access policies, validated operations and Realtime publication entries where the hosted publication exists.

This manual route does not register Supabase CLI migration history. If you use CLI-managed environments, follow the [Supabase migration workflow](https://supabase.com/docs/guides/deployment/database-migrations) from the start; reconcile any manually applied versions before using `db push`. The repository does not yet include a complete local Supabase configuration for Auth and Realtime.

Complete [Google sign-in setup](GOOGLE-SETUP.md), including the redirect allow list, before attempting to join a household.

## 3. Configure and run the frontend

Copy the example environment file:

```sh
cp .env.example .env.local
```

Replace its placeholders with your development project's URL and **publishable** key:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

Do not use a Supabase secret/service-role key, Google client secret, VAPID private key or scheduler token here. Vite embeds its `VITE_` values in the browser bundle. Keep `.env.local` out of Git.

Leave the new feature flags disabled until their matching server setup passes validation:

```dotenv
VITE_PROFILE_PHOTOS_ENABLED=false
VITE_NOTIFICATIONS_ENABLED=false
VITE_WEB_PUSH_PUBLIC_KEY=
```

For an environment with a validated photo service, set `VITE_PROFILE_PHOTOS_ENABLED=true`. For notifications, also set `VITE_NOTIFICATIONS_ENABLED=true` and supply that environment's VAPID **public** key. These are build-time settings; changing them requires rebuilding the static site. See the [preview.5 upgrade steps](#upgrade-to-040-preview5).

Run with the same origin used in your Google and Supabase settings:

```sh
npm run dev -- --host localhost
```

Open `http://localhost:5173/`. If that port is occupied, use the displayed port and update the allowed origin/redirect settings to match. Sign in, create a test household and invite a second test account.

## 4. Build and publish

Build with the intended environment values in place:

```sh
npm run check
```

The website is the **contents of `dist/`**, including `index.html`, assets, icons, `push-sw.js`, `_headers` and `_redirects`. The service worker is used only when notifications are enabled; keep it at the site root so its scope can cover Pact. Do not upload the source repository as a website.

For a Cloudflare Pages Direct Upload project, upload `dist/` or a ZIP whose root contains `index.html`. For an existing project, create a new deployment and choose the intended environment. Keep a known-good deployment available for a frontend rollback. Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/) covers this flow.

For a new Pages project connected to Git, use `npm run build` as the build command, `dist` as the output directory and set the public `VITE_` connection values and intended feature flags in the build environment. Configure a Node version meeting `package.json`. See the [Vite Pages guide](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).

A Direct Upload project cannot be converted to native Git integration in place; that requires a new Pages project. Adding the source to Git does not itself change hosting or enable automatic deployment. [Cloudflare deployment modes](https://developers.cloudflare.com/pages/get-started/direct-upload/)

Allow the actual deployed origin in Google and Supabase as described in [GOOGLE-SETUP.md](GOOGLE-SETUP.md). Rebuild when public environment values change; changing dashboard variables cannot modify an already-uploaded bundle. If you use a custom Supabase domain, review `public/_headers` so the content security policy permits its HTTPS and WebSocket endpoints.

<a id="5-check-with-two-accounts-on-real-phones"></a>

## 5. Verify shared workflows

Keep simulated transactions in a separate development environment. A short check with two independent Google accounts is recommended before a release. Different browsers or separate browser profiles can check shared records; ordinary tabs in the same profile may share one login. Physical phones add keyboard, layout and Home Screen coverage, but are not required for the shared-account checks.

1. Open a personal invitation with the intended Google account. Check account switching preserves the invitation and acceptance adds the member.
2. Add a $10.01 expense with exact shares of $5.01 and $5.00. Both sessions must show the same expense and balances that sum to zero.
3. Add a shopping item, claim it and mark part bought. The remaining quantity should be available for anyone to pick up because partial purchases clear the claim. Verify the other session updates, including after reconnecting.
4. Record a simulated repayment as the sender: with the recipient’s default preference, balances update immediately and history says Settled automatically. Enable approval in the recipient’s Account and record a distinct transfer: this one stays pending until confirmed. Changing the setting must leave any existing pending record unchanged. Then use a separate simulated transfer to test **I received** as the recipient: confirm the receipt and check that both balances update immediately. A partial amount should leave the remainder owing. Check that an existing pending report is confirmed rather than duplicated, and that equal amount/date records require an explicit separate-payment acknowledgement. No real transfer is needed in this synthetic test environment.
5. Check Back, reload and recovery after a save request is interrupted. Going offline before saving instead disables Save; reconnect before submitting.
6. For additional trip-privacy coverage, use a third account excluded from a trip and confirm it cannot access that trip.

Optional physical-device checks cover decimal keyboards, enlarged text, screen-reader navigation and Home Screen installation. Record which checks actually ran. A skipped check remains unverified, even when a release proceeds.

A frontend rollback does not reverse database migrations. Before changing stored-data behaviour, test the migration separately, preserve compatibility with open older clients, and establish a database backup and restore procedure. Pact's CSV/JSON exports are not full backups.

## Upgrade to 0.4.0-preview.6 with photos only

The account redesign can run with photos enabled independently of notifications. On a backend with the existing six core/profile/repayment migrations, apply only `20261011083917_private_profile_photos.sql` if it is not already installed. Deploy `profile-photo` with its pinned `deno.json` and `deno.lock`, gateway `verify_jwt=true`, and the mandatory in-function Auth validation. The platform's server-only default secret is sufficient; photo uploads do not need VAPID keys, a dispatcher token, Vault or Cron.

Validate authenticated status, upload, read and deletion in staging, plus anonymous denial, private bucket limits and service-only RPC grants. Then build the intended environment with:

```dotenv
VITE_PROFILE_PHOTOS_ENABLED=true
VITE_NOTIFICATIONS_ENABLED=false
VITE_WEB_PUSH_PUBLIC_KEY=
```

Keep the environment's normal public connection settings outside Git. Upload the complete generated static build, including `_headers` (which permits authenticated photo blob images), to the intended production deployment. Check Account shows **0.4.0-preview.6** and offers **Choose a photo**. Choose a photo, inspect the square preview and save it. An existing saved photo must be removed before choosing a replacement. Check errors before retrying an uncertain upload.

Do not run a blanket migration push for this selective upgrade: the notification migration precedes the photo migration and has additional configuration requirements. Track the exact applied migration in the deployment record. Existing notification installations remain additive; this photo-only build does not configure or enable production delivery. See [release notes](RELEASE-0.4.0-PREVIEW.6.md) for the dated verification and remaining acceptance scope.

For a frontend rollback, retain the photo schema and private objects. The earlier preview.4 frontend hides the photo controls without deleting stored images or ledger records.

## Upgrade to 0.4.0-preview.5

This candidate includes preview.4's appearance and adds private photos and optional phone notifications. Its staging backend passed the checks in the [release notes](RELEASE-0.4.0-PREVIEW.5.md); production is unchanged and real phone delivery remains unverified. A frontend upload alone cannot activate these features.

### Prepare the backend

1. On a staging backend with the first six migrations installed, apply migrations 7–9 above in order. Keep existing profiles, membership, transaction amounts and payment preferences intact. Reconcile migration history before using CLI `db push` on a manually configured project.
2. Deploy `profile-photo` using its [service guide](../supabase/functions/profile-photo/README.md). Its own Auth validation must run on every request, including when the gateway's legacy JWT check is disabled for an asymmetric-signing-key project. It reads the hosted `SUPABASE_URL` and the `default` entry of `SUPABASE_SECRET_KEYS`, with legacy `SUPABASE_SERVICE_ROLE_KEY` fallback. None of those server keys belongs in the browser.
3. Check the private `profile-photos` bucket, its size/type limits and all applicable `storage.objects` policies. No broad existing policy may grant browser access to this bucket. Validate actual processing, upload, co-member reads, outsider denial, metadata removal, replacement refusal and Storage deletion.
4. Deploy `dispatch-notifications` and configure its [server secrets and Vault/Cron schedule](../supabase/functions/dispatch-notifications/README.md). Its custom scheduler-token check must remain enabled. A browser user token or public publishable key is not permission to dispatch notifications.

For the notification worker, the Edge secrets are `PACT_DISPATCH_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. The subject is a real HTTPS project/contact URL or a mailto contact. Vault holds the private function URL under `pact_notification_dispatch_url` and the matching scheduler token under `pact_notification_dispatch_secret`. Review the [schedule template](../supabase/functions/dispatch-notifications/schedule.sql); it contains secret names only. Never paste actual keys, tokens, project identities or personal contacts into versioned files.

Use a separate VAPID pair and scheduler token for production. Complete the same backend steps there only after reviewing staging results and the deployment target. The frontend's `VITE_WEB_PUSH_PUBLIC_KEY` must match that environment's `VAPID_PUBLIC_KEY`; the public key is safe to embed, its private counterpart is not.

### Validate the enabled frontend

Build a staging site with the corresponding flags enabled. Sign in with synthetic test accounts and check photo preview, save, refresh, deletion and replacement. Interrupt a save and reconcile its status before starting a new upload; never assume a timeout means the image was not stored. Confirm an account change cannot submit the previous account's selected photo under the new session.

Enable phone notifications from Account using an explicit button tap. iPhone and iPad require iOS/iPadOS 16.4+ and Pact opened from its Home Screen installation. Verify a test notification arrives with the app closed, then make a synthetic transaction from a different account and confirm that only involved recipients receive it. Check categories, tone, tapping an alert, and sign-out/account-switch cleanup. Focus, battery settings and browser policy can delay delivery.

An authorized empty-queue worker response or successful Cron invocation verifies service setup, not delivery to a phone. Record the actual device result separately. The isolated browser suite simulates the native push APIs and does not close this gap.

Once the intended backend is ready, upload its configured static build and verify Account shows **0.4.0-preview.5**. If a backend feature is not ready, keep its flag disabled in that build. Reopening Pact must continue to show the same ledger and account preferences.

### Rollback and maintenance

Keep an earlier frontend deployment available. The preview.4 appearance package can run on the existing preview.3 backend without these three new migrations. If preview.5 migrations are already installed, leave them in place during a frontend rollback; do not delete ledger records, photo objects or lifecycle rows as an interface rollback.

Pause the notification Cron job separately if delivery must stop. Reverting frontend files does not revoke installed browser subscriptions, remove service workers or recall pushes already accepted by a provider. Do not claim a rollback has disabled delivery until the schedule and relevant devices are checked.

Use the Storage API and the photo lifecycle checks to clean up expired unfinished uploads. Direct deletion of `storage.objects` metadata is not object deletion. Before administratively deleting an Auth account, remove that account's private photo through the supported service/Storage process. Monitor outbox age and provider failures privately; the worker retains terminal delivery history for seven days and revoked subscriptions for thirty days.

## Upgrade to 0.4.0-preview.4

This is an appearance update on top of preview.3. There is **no new database migration**. If the target backend already has all six migrations, build the configured frontend and upload its static assets. Do not rerun the earlier repayment SQL. If upgrading from preview.2, install the two repayment migrations described below first.

The candidate adopts warm-white, charcoal and lime surfaces, a larger unboxed balance, clean lists, an initials account control, a floating navigation bar and System/Light/Dark appearance controls. All money, membership and recovery operations keep their existing database interfaces. Review [preview.4 release notes](RELEASE-0.4.0-PREVIEW.4.md) before publishing.

After deployment, reload open tabs and check Account shows **0.4.0-preview.4**. Confirm the household, navigation, approval setting and light/dark appearance load. An existing Home Screen shortcut may keep its old icon until the browser refreshes its manifest; this does not require recreating the account. A frontend rollback to preview.3 needs no database rollback.

## Upgrade to 0.4.0-preview.3

From a backend already running the first four migrations, apply the fifth and sixth migrations in order. Validate them in staging before production: existing payment rows must retain their amounts, status and participants, with `recorded_by` backfilled to the sender. Check both recording directions, pending reconciliation, exact duplicate handling, reversal, permissions and replay of a request created before the migration.

Apply both validated migrations to the target backend **before publishing the new frontend**. Existing amounts, participants and statuses must stay unchanged; new preferences default to automatic settlement. Older clients retain sender recording, confirmation and request recovery, but their old explanatory text does not describe automatic settlement, so reload open clients after deployment; a new exact duplicate is now rejected, and the older form has no separate-payment override. A frontend rollback can leave the additive migration in place. Do not rerun older migrations or delete ledger records to roll back the interface.

The preview.3 frontend and repayment function definitions were verified in production on 11 October 2026. See [0.4.0-preview.3 release notes](RELEASE-0.4.0-PREVIEW.3.md) for the verification scope.

## Earlier upgrade from 0.3

When upgrading from 0.3, validate only the new profile migration in a development environment already running the first three migrations. Confirm that an existing client still reads records, that a user can edit only their own name, and that other members see the name after refreshing. Profile changes must leave roles and ledger amounts unchanged. Verify System/Light/Dark appearance and name edits, then exercise custom-share auto-fill with one missing share, several missing shares and an interrupted save. Apply the validated migration to the target backend before publishing the combined frontend. See the [release notes](RELEASE-0.4-PREVIEW.md) for completed verification and remaining limits.

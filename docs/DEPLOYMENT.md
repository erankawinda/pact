# Development setup and deployment

Pact is a static React application backed by Supabase Auth, PostgreSQL and Realtime. Use your own development project and synthetic household records when working on a fork. This repository contains no configured hosted environment or real household data.

## 1. Install and check the source

Use Node.js 22.12 or later and npm. From the repository root:

```sh
npm ci
npm run check
```

`check` runs the Node test suite, TypeScript validation and a Vite build. These checks use disposable local database fixtures and do not require a hosted Supabase project. A successful build without environment variables does not create a connected app.

The separate browser/accessibility suite runs with `npm run test:browser`; see [qa/README.md](../qa/README.md) for Chromium installation and generated artifacts.

## 2. Create a development backend

Create a new, empty Supabase project. The SQL expects the Auth schema and roles supplied by Supabase; it is not an independent plain-PostgreSQL installer.

In that project's SQL Editor, run the full contents of each file once, in this order:

1. [`20261004024901_foundation.sql`](../supabase/migrations/20261004024901_foundation.sql)
2. [`20261004025331_relationship_indexes.sql`](../supabase/migrations/20261004025331_relationship_indexes.sql)
3. [`20261005071001_household_workflows.sql`](../supabase/migrations/20261005071001_household_workflows.sql)
4. [`20261006062916_editable_profiles.sql`](../supabase/migrations/20261006062916_editable_profiles.sql) — adds the own-name update operation.

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

Do not use a Supabase secret/service-role key or a Google client secret here. Vite embeds these two public settings in the browser bundle. Keep `.env.local` out of Git.

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

The website is the **contents of `dist/`**, including `index.html`, assets, icons, `_headers` and `_redirects`. Do not upload the source repository as a website.

For a Cloudflare Pages Direct Upload project, upload `dist/` or a ZIP whose root contains `index.html`. For an existing project, create a new deployment and choose the intended environment. Keep a known-good deployment available for a frontend rollback. Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/) covers this flow.

For a new Pages project connected to Git, use `npm run build` as the build command, `dist` as the output directory and set both `VITE_` variables in the build environment. Configure a Node version meeting `package.json`. See the [Vite Pages guide](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).

A Direct Upload project cannot be converted to native Git integration in place; that requires a new Pages project. Adding the source to Git does not itself change hosting or enable automatic deployment. [Cloudflare deployment modes](https://developers.cloudflare.com/pages/get-started/direct-upload/)

Allow the actual deployed origin in Google and Supabase as described in [GOOGLE-SETUP.md](GOOGLE-SETUP.md). Rebuild when public environment values change; changing dashboard variables cannot modify an already-uploaded bundle. If you use a custom Supabase domain, review `public/_headers` so the content security policy permits its HTTPS and WebSocket endpoints.

<a id="5-check-with-two-accounts-on-real-phones"></a>

## 5. Verify shared workflows

Keep simulated transactions in a separate development environment. A short check with two independent Google accounts is recommended before a release. Different browsers or separate browser profiles can check shared records; ordinary tabs in the same profile may share one login. Physical phones add keyboard, layout and Home Screen coverage, but are not required for the shared-account checks.

1. Open a personal invitation with the intended Google account. Check account switching preserves the invitation and acceptance adds the member.
2. Add a $10.01 expense with exact shares of $5.01 and $5.00. Both sessions must show the same expense and balances that sum to zero.
3. Add a shopping item, claim it and mark part bought. The remaining quantity should be available for anyone to pick up because partial purchases clear the claim. Verify the other session updates, including after reconnecting.
4. Record a simulated repayment. Balances must stay unchanged until its recipient confirms it. No real transfer is needed for this test.
5. Check Back, reload and recovery after a save request is interrupted. Going offline before saving instead disables Save; reconnect before submitting.
6. For additional trip-privacy coverage, use a third account excluded from a trip and confirm it cannot access that trip.

Optional physical-device checks cover decimal keyboards, enlarged text, screen-reader navigation and Home Screen installation. Record which checks actually ran. A skipped check remains unverified, even when a release proceeds.

A frontend rollback does not reverse database migrations. Before changing stored-data behaviour, test the migration separately, preserve compatibility with open older clients, and establish a database backup and restore procedure. Pact's CSV/JSON exports are not full backups.

When upgrading from 0.3, validate only the new profile migration in a development environment already running the first three migrations. Confirm that an existing client still reads records, that a user can edit only their own name, and that other members see the name after refreshing. Profile changes must leave roles and ledger amounts unchanged. Verify System/Light/Dark appearance and name edits, then exercise custom-share auto-fill with one missing share, several missing shares and an interrupted save. Apply the validated migration to the target backend before publishing the combined frontend. See the [release notes](RELEASE-0.4-PREVIEW.md) for completed verification and remaining limits.

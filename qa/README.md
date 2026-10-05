# Browser verification

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

Playwright and axe-core are pinned development dependencies. On Linux, install browser system dependencies with `npx playwright install --with-deps chromium` if required.

The harness starts a local Vite server and headless Chromium. It overrides all frontend connection values with a fictional project, creates disposable PGlite databases, applies the actual migrations and intercepts external HTTP and WebSocket traffic. Google identities, households, shopping and transactions are synthetic. No real account, invitation or hosted database is used.

The ten browser scenarios cover navigation, responsive layouts, light/dark accessibility scans, expense splits and drafts, uncertain request recovery, invitation handoff, shopping purchases, repayment confirmation, corrections/refunds, trips and membership changes. The Node tests in `tests/` provide additional money and database checks.

Generated results and screenshots go to `qa/artifacts/`, which is ignored by Git. Selected synthetic screenshots in `docs/images/` illustrate the app; they are not household records.

The harness also captures `*-preview.png` versions of the three README screens at the same 390 × 844 phone viewport. When refreshing the gallery, review the generated images and copy the full screenshots and matching previews into `docs/images/`. Keep previews at their original aspect ratio; the README links them to the complete screens.

Optional local overrides:

- `PACT_PLAYWRIGHT_MODULE`: absolute path to another Playwright module.
- `PACT_CHROMIUM_PATH`: installed Chromium executable path.
- `PACT_AXE_PATH`: alternative axe script. The pinned axe package is used by default.

## Limits

PGlite serialises the fixture's database queries. These tests do not establish correctness under separate concurrent PostgreSQL sessions, actual Google OAuth, Supabase Realtime delivery, native phone installation or screen-reader use. Axe checks are useful evidence, not a claim of complete accessibility conformance.

`tests/hosted-smoke.sql` is a separate administrative script for an empty development database. It creates synthetic records inside a transaction and rolls them back. It is not part of CI and must not be run against a household's production database.

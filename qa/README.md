# Browser verification

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

Playwright and axe-core are pinned development dependencies. On Linux, install browser system dependencies with `npx playwright install --with-deps chromium` if required.

The harness starts a local Vite server and headless Chromium. It overrides all frontend connection values with a fictional project, creates disposable PGlite databases, applies the actual migrations and intercepts external HTTP and WebSocket traffic. Google identities, households, shopping and transactions are synthetic. No real account, invitation or hosted database is used.

The twenty-three browser scenarios retain the ten original checks for navigation, responsive layouts, light/dark accessibility scans, expense splits and drafts, uncertain request recovery, invitation handoff, shopping purchases, repayment confirmation, corrections/refunds, trips and membership changes. Two custom-split scenarios cover automatic remainders, manually entered zero amounts, overruns and invalid decimals, deriving the total from entered shares, selection and mode changes, background refresh, saved drafts and Review → Edit. The uncertain-save scenario also verifies that retrying an automatically calculated custom split preserves its exact original request.

Four profile and appearance scenarios cover:

- Editing and trimming a display name, persistence after reload, another member seeing the new name after refresh, unchanged roles and ledger records, and no member-email exposure.
- Invalid input, rejected saves and expired-auth responses retaining the entered name for retry.
- Profile editing and appearance preferences before a person belongs to any household.
- System, Light and Dark preferences across reloads and operating-system changes, with long-name layout and axe checks at 320, 390 and 768 pixels.

Four recipient-repayment scenarios cover:

- Recording a partial receipt, mandatory acknowledgement, exact balances visible to both fixture accounts, recorder attribution, activity and reversal.
- Confirming an existing pending sender report without creating a second record, including when the draft's amount differs.
- An explicit separate-payment acknowledgement for equal amount/date records, and rejection of a stale form when a pending report appears before saving.
- A lost save response followed by reload and retry of the same request, without changing balances twice.

Three payment-preference scenarios cover default automatic settlement with lost-response recovery, own-account preference persistence and isolation, unchanged existing pending records after a setting change, and retrying a preference save without changing ledger data. Pending-flow fixtures explicitly enable recipient approval.

The recipient form is checked at mobile widths and scanned with axe in light and dark appearance. The new form and pending-record screen have also been visually inspected. These checks use simulated authenticated sessions, not independent real Google accounts.

Profile reads run against the actual `profiles` table with the fixture user's authenticated role and the migrations' row-level policies. The REST fixture supports array responses and the object response requested by `single()`; it does not replace Google metadata or the authentication session when a display name changes. Profile writes use the real `update_profile` database function. The 30 Node tests in `tests/` provide additional money and database checks. `received-payment.test.ts` exercises the migration on pre-existing payment records, legacy request replay, receipt/reversal balances, both recording orderings, duplicate overrides, permissions and input validation.

Generated results and screenshots go to `qa/artifacts/`, which is ignored by Git. Selected synthetic screenshots in `docs/images/` illustrate the app; they are not household records.

The harness also captures `*-preview.png` versions of the three README screens at the same 390 × 844 phone viewport. When refreshing the gallery, review the generated images and copy the full screenshots and matching previews into `docs/images/`. Keep previews at their original aspect ratio; the README links them to the complete screens.

Optional local overrides:

- `PACT_PLAYWRIGHT_MODULE`: absolute path to another Playwright module.
- `PACT_CHROMIUM_PATH`: installed Chromium executable path.
- `PACT_AXE_PATH`: alternative axe script. The pinned axe package is used by default.

## Limits

PGlite serialises the fixture's database queries. These tests do not establish correctness under separate concurrent PostgreSQL sessions, actual Google OAuth, Supabase Realtime delivery, native phone installation or screen-reader use. Axe checks are useful evidence, not a claim of complete accessibility conformance.

`tests/hosted-smoke.sql` is a separate administrative script for an empty development database. It creates synthetic records inside a transaction and rolls them back. It is not part of CI and must not be run against a household's production database.

`tests/received-payment-hosted.sql` separately validates both repayment migrations in staging. It uses random synthetic identities, authenticated/anonymous role checks and transaction rollback. Run the entire script; both the PASS report and zero post-rollback fixture counts matter. It does not exercise Google OAuth or independent concurrent PostgreSQL sessions.

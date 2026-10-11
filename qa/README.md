# Browser verification

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

Playwright and axe-core are pinned development dependencies. On Linux, install browser system dependencies with `npx playwright install --with-deps chromium` if required.

The harness starts a local Vite server and headless Chromium. It overrides all frontend connection values with a fictional project, creates disposable PGlite databases, applies the actual migrations and intercepts external HTTP and WebSocket traffic. Google identities, households, shopping and transactions are synthetic. No real account, invitation or hosted database is used.

The twenty-four browser scenarios retain the ten original checks for navigation, responsive layouts, light/dark accessibility scans, expense splits and drafts, uncertain request recovery, invitation handoff, shopping purchases, repayment confirmation, corrections/refunds, trips and membership changes. Two custom-split scenarios cover automatic remainders, manually entered zero amounts, overruns and invalid decimals, deriving the total from entered shares, selection and mode changes, background refresh, saved drafts and Review → Edit. The uncertain-save scenario also verifies that retrying an automatically calculated custom split preserves its exact original request.

The main-screen appearance matrix checks both themes at 320, 390, 768 and 1280 pixels, including horizontal overflow, one active navigation item, keyboard navigation and bottom content remaining reachable above the floating navigation. Axe scans run at the smallest and desktop widths, and on the populated shopping list while hovering Mark bought in both themes. A separate balance scenario verifies the written owed, owing and settled labels and complete, unclipped amounts in both themes. A long household name with twelve members and a two-member trip verify compact headers at 320 pixels. The large-balance check uses a seven-digit amount at 320 pixels. The refund flow checks its dialog at a short 568-pixel viewport and verifies keyboard access to the submit action.

Four profile and appearance scenarios cover:

- Editing and trimming a display name, persistence after reload, another member seeing the new name after refresh, unchanged roles and ledger records, and no member-email exposure.
- Invalid input, rejected saves and expired-auth responses retaining the entered name for retry.
- Profile editing and appearance preferences before a person belongs to any household.
- System, Light and Dark preferences across reloads and operating-system changes, with long-name layout and axe checks at 320, 390, 768 and 1280 pixels.

Four recipient-repayment scenarios cover:

- Recording a partial receipt, mandatory acknowledgement, exact balances visible to both fixture accounts, recorder attribution, activity and reversal.
- Confirming an existing pending sender report without creating a second record, including when the draft's amount differs.
- An explicit separate-payment acknowledgement for equal amount/date records, and rejection of a stale form when a pending report appears before saving.
- A lost save response followed by reload and retry of the same request, without changing balances twice.

Three payment-preference scenarios cover default automatic settlement with lost-response recovery, own-account preference persistence and isolation, unchanged existing pending records after a setting change, and retrying a preference save without changing ledger data. Pending-flow fixtures explicitly enable recipient approval.

The recipient form is checked at mobile widths and scanned with axe in light and dark appearance. The new form and pending-record screen have also been visually inspected. These checks use simulated authenticated sessions, not independent real Google accounts.

Profile reads run against the actual `profiles` table with the fixture user's authenticated role and the migrations' row-level policies. The REST fixture supports array responses and the object response requested by `single()`; it does not replace Google metadata or the authentication session when a display name changes. Profile writes use the real `update_profile` database function. The Node tests in `tests/` provide additional money and database checks. `received-payment.test.ts` exercises the migration on pre-existing payment records, legacy request replay, receipt/reversal balances, both recording orderings, duplicate overrides, permissions and input validation.

Generated results and screenshots go to `qa/artifacts/`, which is ignored by Git. Selected synthetic screenshots in `docs/images/` illustrate the app; they are not household records.

The harness also captures `*-preview.png` versions of the three README screens at the same 390 × 844 phone viewport. When refreshing the gallery, review the generated images and copy the full screenshots and matching previews into `docs/images/`. Keep previews at their original aspect ratio; the README links them to the complete screens.

A focused existing-suite rerun can use a name pattern, for example `npm run test:browser -- 'profile|appearance'`. It writes `qa/artifacts/browser-focused-results.json` separately from the full-suite results. Both account harnesses also fail on duplicate React key warnings.

Optional local overrides:

- `PACT_PLAYWRIGHT_MODULE`: absolute path to another Playwright module.
- `PACT_CHROMIUM_PATH`: installed Chromium executable path.
- `PACT_AXE_PATH`: alternative axe script. The pinned axe package is used by default.

## Notifications and private photos

Run the feature-specific checks from the repository root:

```sh
npm test
npm run test:privacy-browser
npm run test:notifications-browser
```

Both additional browser harnesses ignore local environment files and use synthetic HTTP responses with external traffic intercepted. They enable only their feature under test. The existing twenty-four-scenario suite retains its default-disabled feature configuration.

The eight photo browser scenarios use synthetic JPEGs and canvases. The account layout matrix checks 320/390/768 widths in both themes, accessibility and reachable controls. The status-failure scenario keeps an unknown photo slot locked until a successful retry. File selection uses the visible Choose a photo button and the browser file chooser. They verify EXIF orientation, a centred 512-pixel crop, metadata removal, preview before upload, light/dark accessibility and narrow layouts, no original-file upload, stable request IDs and bytes on retry, lost-response reconciliation, unfinished deletion blocking replacement, renewed confirmation after a stale photo version, local rejection of a non-image disguised as JPEG, and delayed session lookup preventing a previous account’s draft or deletion confirmation from writing to another account. Results and a synthetic account screenshot are written to `qa/artifacts/privacy/`. A focused rerun can use a name substring, for example `npm run test:privacy-browser -- 'account change'`; it writes `results-focused.json` without replacing full-suite results.

The notification browser harness covers permission requested by an explicit button gesture, denied and unsupported recovery, iOS installation guidance, category and tone preferences, test delivery requests, device disabling, sign-out/account-change cleanup, stale permission or subscription completion, reset/retry handling, and validated notification navigation. Native Push and Notification APIs are simulated; the harness does not send real push messages. Its results are written to `qa/artifacts/notifications-browser-results.json`.

The backend checks use the real migrations and functions with synthetic managed-platform tables:

- `notifications.test.ts` checks participant and trip isolation, actor exclusion, multiple devices, registration ownership and limits, session expiry/revocation, correction recipient unions, idempotent retries, future-only subscriptions, preferences at enqueue and delivery, repayment/refund transitions, worker leases and permanent endpoint failures. Profile and shopping activity remain silent.
- `profilePhotos.test.ts` checks service-only lifecycle operations, browser Storage denial, current shared membership, membership revocation during a read, deletion before replacement, stale-generation safety, uncertain uploads and expired leases, server image decoding and metadata stripping, streamed body limits and private responses. The injected Edge handler uses the actual lifecycle SQL while object bytes live in a test map.
- `photoProcessing.test.ts` checks JPEG, PNG, WebP and bounded HEIF headers, byte offsets, dimensions and source-size limits, malformed containers, unsupported animation and non-image input. Native browser decoding and processing are exercised separately by the photo browser suite.

The Storage fixture models bucket configuration, object metadata and row-level access only. It does not emulate hosted Storage HTTP requests, object cleanup internals or signed Google sessions. Database requests are serialized, so interleaved retry tests do not substitute for simultaneous PostgreSQL sessions.

## Limits

PGlite serialises the fixture's database queries. These tests do not establish correctness under separate concurrent PostgreSQL sessions, actual Google OAuth, Supabase Realtime delivery, native phone installation or screen-reader use. They also do not verify APNs/FCM/Mozilla push delivery, real lock-screen behavior, OS battery restrictions, or native HEIC decoding on a particular phone. Those require hosted and physical-device acceptance checks. Axe checks are useful evidence, not a claim of complete accessibility conformance.

`tests/hosted-smoke.sql` is a separate administrative script for an empty development database. It creates synthetic records inside a transaction and rolls them back. It is not part of CI and must not be run against a household's production database.

`tests/received-payment-hosted.sql` separately validates both repayment migrations in staging. It uses random synthetic identities, authenticated/anonymous role checks and transaction rollback. Run the entire script; both the PASS report and zero post-rollback fixture counts matter. It does not exercise Google OAuth or independent concurrent PostgreSQL sessions.

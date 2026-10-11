# Minimal appearance update — 0.4.0-preview.4

Prepared **11 October 2026**. **Ready for manual upload; this candidate is not deployed yet.** The existing preview.3 frontend and its profile/repayment function definitions were verified in production during this preparation.

## What changes

Pact now uses warm white, charcoal and a restrained lime accent. The balance is a large unboxed amount with a written owed/owing/settled state. Member and expense lists use aligned amounts and light separators, and a floating navigation bar keeps the four main screens within reach.

The header includes the signed-in person's initials and a compact link to household members. Home shows shopping and pending-approval shortcuts. Account provides native System, Light and Dark choices; the app's browser colours and installation icons follow the new palette. Forms, review screens, history, errors and recovery messages use the same spacing and controls.

Balances offers **I paid** and **I received**. Both use the existing repayment operations from preview.3. Automatic settlement remains the default; each recipient can require approval for future incoming records. Changing that preference still uses an explicit save, and existing pending records remain pending. No stored-data or membership rules change in this appearance release.

## Installation and rollback

There is **no new database migration**. A backend already running preview.3 has everything this release needs. Upload the configured static build to the existing Pages project, then reload open app tabs and check Account shows **0.4.0-preview.4**.

For an older backend or a new installation, follow the [deployment guide](DEPLOYMENT.md); apply any missing migrations before publishing. Never rerun an already installed repayment migration.

Keep the prior preview.3 deployment available for frontend rollback. This appearance update needs no database rollback. Existing Home Screen shortcuts may retain an older icon until the browser refreshes their manifest. Configured bundles and private upload instructions remain outside the public repository.

## Verification

- All **30 Node/database tests** passed; existing ledger, permission, duplicate, reversal, profile and recovery coverage remains.
- TypeScript and Vite production builds passed. Configured builds retain the existing bundle-size advisory.
- All **24 isolated browser scenarios** passed. Main screens cover light/dark appearance at 320, 390, 768 and 1280 pixels, visible current navigation, keyboard use and bottom-content clearance.
- Additional checks cover exact owed/owing/zero balances, large amounts, a 12-person household with a long name, a two-person trip, short-height dialogs, long profile names and persisted System/Light/Dark choices.
- Synthetic screenshots of Home, Balances, shopping, expense review, profiles and repayment forms were inspected. Automated accessibility scans reported no violations in the covered states.
- Read-only production preflight matched the preview.3 JavaScript bundle and 15 profile, household-state and repayment function bodies against the reviewed source. No household records were read or changed by that preflight.

The browser harness intercepts external requests and uses synthetic identities with disposable local databases. These results do not establish real multi-account Realtime delivery, concurrent PostgreSQL sessions, native Home Screen installation or screen-reader usability. No two-phone acceptance test was performed. Earlier hosted staging repayment checks are documented in the [preview.3 release notes](RELEASE-0.4.0-PREVIEW.3.md); they are not presented as new hosted tests for this appearance update.

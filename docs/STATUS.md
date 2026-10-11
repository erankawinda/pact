# Project status

Pact **0.4.0-preview.3** was verified in production on **11 October 2026**: the served JavaScript matched the prepared release bundle and 15 profile, household-state and repayment function bodies matched the reviewed source. This is a dated verification, not a live service-status report. The read-only preflight did not read or change household records.

## Next candidate: private photos and transaction notifications

**0.4.0-preview.5**, prepared **11 October 2026**, is a **staging candidate**. Hosted backend checks passed; production has not been updated. Real phone notification delivery remains unverified.

| Candidate check | Evidence |
|---|---|
| Node suite | All 57 tests passed: 30 existing, 9 notification, 6 photo, 4 image-header and 8 service-worker tests |
| Isolated browser suites | All 39 scenarios passed: 24 existing, 6 photo and 9 notification scenarios |
| Notification worker | Deno typecheck and 7 synthetic-provider runtime tests passed |
| Hosted staging | 13 check groups passed, including actual image processing/Storage lifecycle, co-member and outsider access, revoked membership, metadata/body limits and deletion cleanup |
| Dispatcher and scheduler | Unauthorized invocation returned 401; authorized empty-queue invocation and three scheduled calls returned 200 |
| Backend source parity | All 30 reviewed function bodies matched final source |

The candidate adds device opt-in notifications with private generic text, category and tone choices, and session/membership checks. It adds private profile photos with preview, metadata removal and deletion before replacement. See [preview.5 release notes](RELEASE-0.4.0-PREVIEW.5.md) for the completed checks and remaining deployment steps.

The staging advisor's private-table RLS notices are expected because client access is intentionally denied. Its existing password-protection warning was not introduced by this Google-sign-in update. These observations do not replace access testing.

## Appearance package ready for upload

**0.4.0-preview.4** remains **ready for manual upload and not deployed yet**. It introduces warm-white, charcoal and lime colours, an unboxed balance, aligned lists, a floating navigation bar and account initials. It passed 30 Node/database tests and 24 isolated browser scenarios, including both themes, small screens, large/zero balances and automated accessibility checks. TypeScript and production builds passed; configured builds retain the bundle-size advisory.

This separate package needs **no new SQL** on a preview.3 backend. Its production preflight matched the prepared preview.3 frontend and 15 existing profile/repayment function bodies. See [preview.4 release notes](RELEASE-0.4.0-PREVIEW.4.md). Preview.5 includes that appearance but requires its additional migrations and server setup.

## Core features

- Home, Shopping, Expenses and Balances navigation.
- Google sign-in, personal invitations, household membership and selected trip participants.
- Equal/custom expense splits, automatic remaining shares, corrections, voids and refunds.
- Own-display-name editing, initials avatars and browser-specific appearance preferences.
- Shopping requests, claims, partial purchases and purchase-linked expenses.
- Repayment recording by sender or recipient, automatic settlement by default, personal incoming approval preferences and reversal history.
- Draft/save recovery, activity history and CSV/JSON exports.

## Previous release verification: 0.4.0-preview.2

Checks on the released source passed on **6 October 2026**:

| Check | Evidence |
|---|---|
| Local Node/database tests | All 21 passed using synthetic data and the actual migrations in disposable PGlite databases |
| TypeScript and Vite build | Passed; the existing bundle-size warning remains |
| Isolated browser suite | All 16 scenarios passed, including profile, auto-fill, accessibility and responsive-layout checks |
| GitHub Actions | [Passed on the deployed source commit with Node.js 22](https://github.com/erankawinda/pact/actions/runs/37428554418) |
| Hosted staging database | All 11 validation groups passed; synthetic fixtures rolled back; security advisors reported no errors or warnings |
| Staging Google sign-in and account settings | Real sign-in, profile save/reload/restore and appearance persistence verified |
| Production deployment | Profile migration applied before the frontend; stored application data unchanged; served assets matched the release bundle; existing session, household and account settings loaded |

Local runs used Node.js 25.6.1. CI used Node.js 22. See [qa/README.md](../qa/README.md) for reproducing the isolated browser suite and [release notes](RELEASE-0.4-PREVIEW.md) for hosted-validation scope. Generated artifacts and private deployment evidence are excluded from Git.

## Verification limits and next work

Two-phone and independent two-account acceptance were **skipped for 0.4.0-preview.2 at the maintainer's request**, not passed. A future [shared-workflow check](DEPLOYMENT.md#5-verify-shared-workflows) can use two independent browser sessions. Actual phones add native keyboard, Home Screen and accessibility coverage.

PGlite serialises fixture queries, and the browser harness intercepts external traffic. These tests do not certify races across separate PostgreSQL connections, real multi-client Realtime delivery, native installation or screen-reader use. The hosted database and one-account Google checks extend that evidence without closing all of those gaps.

Real phone push acceptance, concurrent PostgreSQL sessions, broader device checks and a backup/restore rehearsal remain outstanding. Receipt attachments, monthly reports, dispute flags, a separate pantry inventory and an import/restore flow remain planned.

The app records repayments; it does not transfer money. It has no offline transaction queue. JSON export is a group snapshot, not a complete database/Auth/Storage backup. See [ROADMAP.md](ROADMAP.md) for the next work and [RELEASE-0.3.md](RELEASE-0.3.md) for the earlier milestone.

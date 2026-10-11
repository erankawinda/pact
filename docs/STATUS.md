# Project status

Pact **0.4.0-preview.3** was verified in production on **11 October 2026**: the served JavaScript matched the prepared release bundle and 15 profile, household-state and repayment function bodies matched the reviewed source. This is a dated verification, not a live service-status report. The read-only preflight did not read or change household records.

## Next candidate: minimal appearance

**0.4.0-preview.4**, prepared **11 October 2026**, is **ready for manual upload and not deployed yet**. It adopts warm-white, charcoal and lime colours, an unboxed balance, aligned divider lists, a floating navigation bar, account initials and native appearance choices. The existing payment approval, reversal and recovery behavior remains. There is no new database migration.

| Candidate check | Evidence |
|---|---|
| Node/database suite | All 30 tests passed |
| TypeScript and production builds | Passed; configured build retains the bundle-size advisory |
| Isolated browser suite | All 24 scenarios passed, including main screens in both themes at 320/390/768/1280 widths |
| Layout and access checks | Large and zero balances, long names, 12-person household, two-person trip, keyboard navigation, footer clearance, short dialogs and automated accessibility scans |
| Visual review | Synthetic app screenshots inspected; README gallery refreshed |
| Production preflight | Preview.3 public frontend and profile/repayment function bodies match the reviewed source; no new SQL needed |

See [preview.4 release notes](RELEASE-0.4.0-PREVIEW.4.md) for deployment order and validation limits. The previous repayment release's 11 hosted staging check groups remain recorded in [preview.3 notes](RELEASE-0.4.0-PREVIEW.3.md); the appearance release does not change their schema or functions.

## Implemented

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

Concurrency testing, broader device checks and a backup/restore rehearsal remain outstanding. Receipt attachments, monthly reports, dispute flags, a separate pantry inventory and an import/restore flow remain planned.

The app records repayments; it does not transfer money. It has no offline transaction queue. JSON export is a group snapshot, not a complete database/Auth/Storage backup. See [ROADMAP.md](ROADMAP.md) for the next work and [RELEASE-0.3.md](RELEASE-0.3.md) for the earlier milestone.

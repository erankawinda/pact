# Project status

Pact **0.4.0-preview.2** was deployed on **6 October 2026**. It is a household pilot combining custom-share auto-fill, editable display names and System/Light/Dark appearance with the existing shared-house workflows. This is a dated release milestone, not a live service-status report.

## Next candidate: repayments and personal approval preferences

**0.4.0-preview.3**, prepared **11 October 2026**, is **not deployed to production yet**. Payments settle automatically by default; each recipient can enable approval in Account for future incoming records across their households and trips. Existing pending records still require review. The recipient can enter a transfer that the sender forgot to record, acknowledge receipt and update balances immediately. Pending sender reports must be reconciled first; matching amount/date records require an explicit separate-payment acknowledgement. Recorder attribution, activity and reversal preserve the audit trail.

| Candidate check | Evidence |
|---|---|
| Local Node/database tests | All 30 passed, including migration backfill, old request replay, balances, duplicate guards and permissions |
| TypeScript and Vite build | Passed |
| Isolated browser suite | All 23 scenarios passed, including recipient recording, pending reconciliation, duplicate handling and lost-response recovery |
| Visual review | New recipient form inspected in light/dark appearance; pending-record screen inspected |
| Hosted staging migration | Both migrations installed; all 11 combined check groups passed with synthetic fixtures rolled back |
| Hosted staging advisors | No database security errors or warnings; existing INFO findings for RPC-only tables without direct-access policies remain |

The Auth advisor separately warns that leaked-password protection is disabled. Pact's operations require a verified Google identity; the warning is not a finding introduced by this migration. Account owners can review [Supabase's password-protection guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

See the [candidate release notes](RELEASE-0.4.0-PREVIEW.3.md) for compatibility and deployment order. Test results above do not establish concurrency across independent database sessions.

## Implemented

- Home, Shopping, Expenses and Balances navigation.
- Google sign-in, personal invitations, household membership and selected trip participants.
- Equal/custom expense splits, automatic remaining shares, corrections, voids and refunds.
- Own-display-name editing, initials avatars and browser-specific appearance preferences.
- Shopping requests, claims, partial purchases and purchase-linked expenses.
- Repayment recording, recipient confirmation and reversal; direct recipient recording is included in the new candidate.
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

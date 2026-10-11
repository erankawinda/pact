# Project status

Pact **0.4.0-preview.6** was verified in production on **11 October 2026**. All nine served static files matched the reviewed release package. The photo backend was installed and checked before that upload. This is a dated verification, not a live service-status report; no real household records or photos were used as test fixtures.

## Current profile release

**0.4.0-preview.6** is the current production frontend. Photos are enabled; transaction notifications remain disabled. The deployment contains the reviewed account redesign and photo controls. A real production-account upload remains unverified.

The account page now groups a larger avatar, display name and actual membership role in one identity card, followed by appearance/payment settings and private sign-in details. Photo controls support choosing a file, local preview, saving, deletion before replacement and recoverable errors. This interface preserves the existing permissions, ledger operations and photo-processing limits.

| Check | Evidence |
|---|---|
| Source validation | Public privacy gate, 61 Node tests, TypeScript and configured production build passed |
| Continuous integration | [Preview.6 CI passed](https://github.com/erankawinda/pact/actions/runs/38130776233): all 41 browser scenarios, both Edge entrypoint checks and 7 notification-worker tests |
| Production frontend | All 9 served files matched the prepared preview.6 package; photo controls are included |
| Existing browser coverage | All 24 scenarios passed in GitHub Actions on the preview.6 source |
| Notification browser suite | 9 scenarios passed with simulated native APIs; this does not verify delivery to a real phone |
| Photo/account browser suite | 8 scenarios passed, including the actual file chooser, 320/390/768 layouts in both themes, accessibility, status retry and account-switch safety |
| Hosted staging photo service | Gateway JWT verification enabled; ES256 authenticated status/read 200, upload 201, delete 200, subsequent read 404; synthetic account and Storage objects cleaned up |
| Production backend | Five photo function bodies match staging; private bucket capped at 256 KiB; client table/RPC access denied; anonymous and invalid-token requests return 401 |

The production photo service now requires both gateway JWT verification and the function's own trusted Auth check. A real production account's upload has not yet been exercised; deployment verification is distinct from that account-level check. Private-table RLS notices reflect intentionally denied browser access. The pre-existing [leaked-password-protection advisory](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) remains; this Google-sign-in update did not introduce it. See [preview.6 release notes](RELEASE-0.4.0-PREVIEW.6.md).

## Transaction notifications remain in staging

[0.4.0-preview.5](RELEASE-0.4.0-PREVIEW.5.md) introduced the photo service and optional transaction notifications. Its earlier hosted staging validation passed 13 check groups, 30 function-body comparisons, dispatcher authorization and scheduled invocations. The dispatcher also passed seven synthetic-provider runtime tests. These checks do not prove delivery to a real phone. Production has no notification dispatcher or schedule installed by this release.

## Core features

- Home, Shopping, Expenses and Balances navigation.
- Google sign-in, personal invitations, household membership and selected trip participants.
- Equal/custom expense splits, automatic remaining shares, corrections, voids and refunds.
- Own-display-name editing, initials/private photo avatars and browser-specific appearance preferences.
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

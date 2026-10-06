# Project status

Pact 0.3 is an early household pilot. The 0.3 frontend was deployed and Google sign-in was verified on **5 October 2026**. Real two-phone acceptance testing remains outstanding. This is a dated release milestone, not a live service-status report.

## Profile preview branch

Version **0.4.0-preview.1** adds own-name editing and System/Light/Dark appearance on the `feat/basic-profiles` branch. It has not been deployed. It is based on the 0.3 code and does not yet include the separately prepared 0.3.1 auto-fill source; that source needs review and integration before a combined release.

Local verification on **6 October 2026** passed: all **16** Node/database tests, TypeScript and Vite build, and all **14** browser scenarios. The four added scenarios cover profile persistence, visibility after another member refreshes, unchanged roles/ledger amounts, validation and failed-save recovery, accounts without a household, and appearance with mobile layout/axe checks. Tests use synthetic data and the actual migrations in disposable PGlite databases.

The profile migration has not been applied to a hosted database. Local catalog checks verify function grants and search paths; hosted database advisors and real-phone acceptance remain deployment checks. See [preview release notes](RELEASE-0.4-PREVIEW.md).

## Implemented

- Home, Shopping, Expenses and Balances navigation.
- Google sign-in, personal invitations, household membership and selected trip participants.
- Equal/exact expense splits, corrections, voids and refunds.
- Shopping requests, claims, partial purchases and purchase-linked expenses.
- Repayment recording, recipient confirmation and reversal.
- Draft/save recovery, activity history and CSV/JSON exports.

## Verification and its limits

Fresh checks on the prepared repository passed on **5 October 2026**:

- `npm run check`: all 12 tests, TypeScript validation and the production build passed.
- `npm run test:browser`: all ten Chromium scenarios passed, including the required axe accessibility checks. The suite checks the four main screens in both themes and layouts at 320/390/768/1280px.

These local runs used Node.js **25.6.1**. The GitHub Actions workflow is configured for **Node.js 22**; that configuration is separate from a completed hosted CI run. See [qa/README.md](../qa/README.md) to reproduce the browser checks. Generated artifacts are ignored by Git.

PGlite fixtures exercise the migrations with synthetic identities and data. The browser harness disables environment-file loading, injects fictional connection values and intercepts external traffic. It does not establish Google OAuth behaviour, hosted Realtime delivery, separate-connection concurrency or real-phone accessibility. The dated Google sign-in check covers one live sign-in flow, not all multi-user acceptance cases.

## Outstanding

Complete the [two-account phone checks](DEPLOYMENT.md#5-check-with-two-accounts-on-real-phones), concurrency testing and a restore rehearsal. Receipt attachments, monthly reports, dispute flags, a separate pantry inventory and an import/restore flow remain planned.

The app records repayments; it does not transfer money. It has no offline transaction queue. JSON export is a group snapshot, not a complete database/Auth/Storage backup. See [ROADMAP.md](ROADMAP.md) for the next work and [RELEASE-0.3.md](RELEASE-0.3.md) for the release details.

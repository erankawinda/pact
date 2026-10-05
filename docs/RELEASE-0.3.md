# Pact 0.3 — household workflows

Released 5 October 2026. The frontend was deployed and a Google sign-in flow was verified that day. Two-phone acceptance remains outstanding; see [STATUS.md](STATUS.md) for scope and limits.

## What changed

The interface now has four everyday destinations: Home, Shopping, Expenses and Balances. Household and trip management, invitations, activity and settings remain available as supporting screens.

- **Shopping:** requests, priority, claims, partial purchases, undo, Need again and purchase-linked expenses.
- **Repayments:** recipient confirmation/rejection, sender cancellation and audited reversal. Pending repayments do not affect balances.
- **Expense history:** correction creates a replacement while retaining the original; refunds allocate exact cents and cannot exceed the remaining amount.
- **Membership:** selected trip participants, invitation revocation, member management and group rename/archive/reopen. Household revocation also gates linked trip access.
- **Exports:** CSV includes expense/share/refund/repayment/balance records; formula-like prefixes are neutralised. An incomplete expense export fails instead of silently omitting older records. JSON provides a group snapshot.

## Reliability and usability

Invitations are captured in an already-open app, retained across account switching and bound to the recipient submitted when a link is created. Expense entry requires explicit exact shares, keeps local drafts and updates stale member selections.

Bounded requests and durable pending operations support sign-in recovery and safe retries after an uncertain response. Actor-scoped operation receipts can reconcile already-committed writes after permissions change, returning the original result identifier.

Browser history supports Back navigation. Search uses displayed category labels. Light/dark contrast and narrow-screen balance layouts were adjusted.

## Repository verification

Fresh repository checks completed on 5 October 2026:

| Check | Outcome |
|---|---|
| `npm run check`: Node tests, including money/storage/invitation/export and database workflows | All 12 tests passed |
| TypeScript and production build | Passed; non-blocking bundle-size warning |
| `npm run test:browser`: isolated Chromium scenarios | All ten passed |
| Required axe accessibility scans | Passed for four main screens, light and dark themes |
| Layout checks | 320, 390, 768 and 1280px |

The browser harness uses a disposable PGlite database with the actual migrations behind intercepted requests. It disables environment-file loading and injects fictional connection values. Its identities and records are synthetic; external traffic is intercepted. Scenarios cover invitation switching, navigation and draft recovery, uncertain responses, shopping, repayments, corrections/refunds/export, trips, membership changes and large balances.

The local verification used Node.js 25.6.1. GitHub Actions is configured to repeat the checks on Node.js 22; configuration alone is not a completed CI result. Playwright and axe are pinned development dependencies. See [qa/README.md](../qa/README.md) for reproduction instructions; generated results and screenshots are ignored by Git.

## Limits

Local fixtures do not certify live Realtime, simultaneous independent database sessions, installed-phone behaviour or screen-reader use. The Google sign-in milestone does not replace a two-person invitation and transaction test.

Receipt images, monthly summaries, disputes, pantry inventory and full restoration remain planned. Exports are not a full backup. Setup and acceptance instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

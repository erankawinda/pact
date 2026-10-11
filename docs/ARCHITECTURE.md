# Architecture

Pact keeps the interface in a static React application and the shared records and permissions in PostgreSQL. There is no separate application server in this repository.

```mermaid
flowchart LR
    Browser[React app] -->|Sign in| Auth[Supabase Auth]
    Auth <-->|OAuth| Google[Google]
    Browser -->|Queries and validated RPCs| DB[Supabase PostgreSQL]
    DB -->|Change notification| RT[Supabase Realtime]
    RT -->|Refresh household snapshot| Browser
    Browser <--> Local[Browser draft and recovery storage]
```

## Source map

| Area | Responsibility |
|---|---|
| `src/App.tsx`, `src/navigation.ts` | Session state, screens and browser history |
| `src/api.ts`, `src/useHousehold.ts` | Supabase connection, snapshots, refresh and Realtime subscriptions |
| `src/AccountProfile.tsx`, `src/profile.ts` | Own display name, account details and device appearance preference |
| `src/ExpenseForm.tsx`, `src/money.ts` | Expense entry, whole-cent parsing and equal/exact splits |
| `src/pendingExpense.ts`, `src/useMutation.ts` | Store a request before sending; retry the same operation after an uncertain response |
| `src/Shopping.tsx`, `src/HouseholdViews.tsx` | Shared shopping, expense history, balances and repayments |
| `src/Management.tsx`, `src/GroupForms.tsx`, `src/invitations.ts` | Households, trips, invitations and member administration |
| `src/export.ts` | CSV and JSON group exports |
| `supabase/migrations/` | Schema, row-level access rules, RPCs and financial invariants |
| `tests/`, `qa/` | Unit/database tests and isolated browser scenarios |

## Shared data and access

A group is either a household or a trip under a household. Membership records carry an organiser/member role and active/revoked status. Trip membership is limited to selected household members; household access also gates linked trip access.

Google identities create profile records. Personal invitation tokens are stored as hashes and tied to an intended email address, with expiry and revocation. A signed-in user must accept a matching invitation before joining.

An own-name update RPC derives its target from the verified session, never a supplied user ID. Profile names remain visible to authorised co-members; private account emails and appearance choices are not added to shared profile rows. Names can change in history displays, while ledger references keep their immutable user IDs. Appearance is stored on the device and can follow the operating system.

Readable tables use row-level security. Clients cannot write financial and workflow tables directly; public RPC wrappers call private functions that check identity, membership, role and input before a transaction commits. The database, rather than hidden buttons, enforces permission decisions.

## Money and history

Amounts use integer cents. Equal splits distribute leftover cents deterministically; exact splits must sum to the total. The current product uses AUD and Melbourne dates.

Custom splits keep manual values separate from calculated shares. One unknown share receives the remainder; several unknown shares require the explicit equal-remainder choice. An entered zero is fixed, while a blank is unknown. Review freezes the resulting integer shares, so interrupted saves retry the same request rather than recalculating against a newer draft.

Balances are derived from posted expenses and shares, refunds and confirmed repayments. Sender-recorded repayments settle automatically by default. If the recipient has enabled approval, new reports start pending and affect balances only after the recipient confirms. Existing pending records are not changed by a preference switch. In the 0.4.0-preview.3 candidate, recipients can instead record money already received: the session fixes the recipient, and that record is confirmed immediately. Amounts may be partial; the app does not cap transfers to a suggested balance or move money.

A recipient cannot create another repayment while any pending record exists from the selected sender in that group. They must explicitly confirm or reject the pending report first. Both recording directions also check for a pending or confirmed record with the same group, sender, recipient, amount and date. A deliberate **This is a separate payment** acknowledgement allows distinct transfers with identical details; it cannot bypass the recipient's pending-record check. Different dates or amounts are not automatically treated as duplicates.

The new `record_repayment` RPC and compatible `record_payment` RPC use the same insert helper. A transaction advisory lock serialises each directed participant pair, including when no payment row exists yet. Payment actions acquire that pair lock before locking their row. Request replay runs before these checks, so checking an uncertain save returns its earlier result without creating a second record. The old RPC retains its signature and original request hash; new exact duplicates are rejected, and older clients cannot override that guard.

`recorded_by` identifies the participant who entered a payment; the migration backfills existing rows with their sender. Receipt activity identifies the recipient as the actor. Confirmed payments can be reversed by their recipient or an organiser, with a reason, while preserving history. Corrections retain the voided original expense and create a replacement; refunds are bounded by the refundable amount.

Request IDs and stored operation results let supported mutations reconcile a retry without applying the same request twice. Version checks detect edits based on stale state. Local tests exercise these rules, but they do not certify races across independent PostgreSQL connections.

## Synchronisation and browser storage

Realtime notifications trigger a fresh household snapshot. The app also refreshes on focus, visibility changes, reconnect and every 30 seconds while visible and online. The database remains authoritative; the client does not merge an offline ledger.

Expense drafts and pending operations use browser local storage, scoped to the user and group. Invitation and sign-in return state use session storage. Losing browser data can lose an unfinished draft or recovery request, so storage is not a backup. A network timeout does not prove a write failed; use the existing recovery action before entering the same expense again.

## Hosting and scope

Vite emits static files for hosting. The manifest and icons support a Home Screen shortcut with standalone presentation. There is no service worker or offline transaction queue in this version.

Only a Supabase URL and publishable key belong in the frontend build. Google secrets and privileged Supabase keys stay outside it. The checked-in headers assume hosted `*.supabase.co` endpoints.

JSON export is a group snapshot, not a restorable database/Auth/Storage backup. Receipt attachments, reports and other deferred features are tracked in [ROADMAP.md](ROADMAP.md).

### Payment preferences

The verified caller reads and updates only their own global `require_payment_approval` preference through RPCs with no target-user argument. It defaults to false. Household snapshots expose this preference to authorised co-members so the sender sees the applicable rule. Recording locks the recipient profile while deciding between automatic settlement and pending approval. `confirmation_method` distinguishes automatic settlement from receipt acknowledged by the recipient; reversal retains this attribution. Existing payment amounts, statuses and participants are not changed by the preference migration.

# Repayments and personal approval preferences — 0.4.0-preview.3

Prepared **11 October 2026**. **Verified in production on 11 October 2026** during preparation of the following appearance release. The served JavaScript matched the prepared release bundle, and 15 profile, household-state and repayment function bodies matched the reviewed migrations. This read-only check did not create or modify household records.

## What changes

A recipient can now record money already received when the sender has not entered it. From Balances, choose **I received money**, or **I received this** beside an incoming suggestion. Check the sender, actual amount and date, acknowledge receipt, then confirm. Partial payments are supported. The new record is confirmed immediately, so both balances update without waiting for another action from the sender.

Recording money sent now settles it immediately by default. Each recipient controls **Account → Payment approval → Require my approval for repayments to me**. When enabled, new payments to that person wait for their confirmation. The preference applies across all their households and trips and can only be changed by that person. The sender sees the applicable rule before saving.

Changing the setting leaves existing pending records awaiting review. History distinguishes **Settled automatically** from **Confirmed received**, so an automatic record does not claim the recipient acknowledged receipt. Incorrect settled records can be reversed by the recipient or an organiser. Pact records transfers; it does not send money.

## Preventing duplicate records

- If any pending report exists from the selected sender to the recipient in this group, the recipient must explicitly confirm it or return to Balances to reject it before creating another record. Changing the amount or date does not bypass this check.
- Either recording direction checks for existing pending or confirmed records with the same participants, amount and date. Distinct transfers with identical details require **This is a separate payment**. This does not override the recipient's pending-report block.
- A stale form is checked again by the database. An uncertain save keeps its original request for recovery; retrying does not create another payment.

These checks do not infer that transfers with different amounts or dates are duplicates. Check the actual transfer details before recording money.

Repayment history identifies who recorded the payment, and recipient receipts appear in Activity. The recipient or an organiser can reverse a confirmed record with a reason; history remains available.

## Database and compatibility

The fifth migration, [`20261011030705_received_repayments.sql`](../supabase/migrations/20261011030705_received_repayments.sql), adds `recorded_by`, backfills existing records to their sender and introduces `record_repayment`. The authenticated session determines the recording participant; callers cannot record a receipt on another recipient's behalf. Active household and effective trip membership remain required.

The sixth migration, [`20261011035030_recipient_payment_preferences.sql`](../supabase/migrations/20261011035030_recipient_payment_preferences.sql), adds the recipient-owned preference and confirmation method. Existing amounts, statuses and participants stay unchanged. Existing acknowledged receipts are labelled as recipient-confirmed; new preferences default to automatic settlement.

The old `record_payment` and `payment_action` signatures and request hashes remain compatible. Older clients can still send, confirm and recover committed requests, but sender recording now follows the recipient’s preference. Reload older clients because their explanatory text still describes mandatory approval. A newly submitted exact duplicate is rejected; an older client must refresh to the new interface to acknowledge a genuinely separate transfer.

Both recording paths and payment actions share a transaction lock for the directed participant pair. Apply both migrations in order to the target backend **before publishing the frontend**. A frontend rollback can retain the additive schema and existing records. See [deployment instructions](DEPLOYMENT.md#upgrade-to-040-preview3).

## Verification and remaining work

- **30 Node/database tests passed**, including migration backfill, legacy receipts, exact balances, duplicates, reversal, permissions and validation.
- **TypeScript and the Vite build passed.**
- **23 isolated browser scenarios passed.** New cases cover recipient entry, partial amounts, pending reconciliation, deliberate separate transfers, stale forms, automatic settlement, personal approval preferences and lost-response recovery.
- The recipient form was visually inspected in light and dark appearance; the pending-record screen was also inspected.
- Both migrations were applied to isolated hosted staging. All **11 hosted validation groups passed**, including role boundaries, defaults, both payment directions, global preference scope, unchanged pending records and retry safety. Synthetic fixtures were rolled back.
- Staging database security advisors reported no errors or warnings. Existing INFO findings for intentionally RPC-only tables without direct-access policies remain. The separate Auth warning about disabled leaked-password protection remains; see [Supabase guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Pact's operation guard still requires verified Google identities.

Local tests use synthetic records and PGlite, whose queries are serialised. They cover both recording orderings but do not prove behaviour across concurrent PostgreSQL connections, real multi-client Realtime delivery or physical-device accessibility. No new independent two-account or two-phone acceptance is claimed.

The originally prepared upload has since been installed. Do not reapply those migrations to an already upgraded backend. A new installation still needs all six migrations in order. New hosted Google-account/device acceptance has not been run. Configured bundles, environment identifiers, credentials, invitation links and real household records remain outside this public repository.

# Include now, join later

## Availability

This feature is prepared in source for the next update. Production remains **0.4.0-preview.7**; the pending-participant migration and interface are not yet confirmed live. Automatic invitation email is a separate optional feature and remains disabled until its verified sender configuration and acceptance checks are complete. Creating a personal link does not send an email.

The feature lets an organiser include someone in a household or trip before they accept their invitation. It does not create a fake account or grant access on their behalf. A trip place belongs only to that trip and does not add the person to its parent household or a global friends directory.

## The experience

1. In **People & trips**, or while adding an expense, an organiser chooses **Include someone** and enters their name and the Google email they will use to join.
2. Pact creates a place for that person in this group's ledger and a personal invitation valid for seven days. While the invitation is active, the person can be chosen as a payer or included in an equal or custom split. The interface marks them as invited.
3. The organiser shares the link, or uses invitation email if that service has been enabled. The expense can be completed without waiting for acceptance.
4. The recipient signs in with the invited Google account. Before joining, they see the selected group and a summary of their own recorded expense count, paid amount, share and net balance. They cannot browse the group's ledger or other people's records at this stage.
5. If records already exist, they review the summary before joining. **Joining connects their account to those records; it does not approve the amounts.** If the records change while they are reviewing, Pact requires a refreshed summary.
6. Their existing place becomes their account's place in the group. Their own profile name and permitted photo appear, while amounts, history and the people who recorded entries stay unchanged.

For example, a trip organiser can record a $30 purchase shared equally by three people, including one invited friend. That friend's $10 share remains attached to the same participant when they join; acceptance creates neither a second share nor a replacement expense.

## Identity and access

| Record | Identity used |
|---|---|
| Expense payer, expense/refund share, repayment sender/recipient | Stable participant ID within the group |
| Membership and organiser role | Auth account ID |
| Expense creator, payment recorder, activity actor, shopping claim | Auth account ID |
| Profile, photo, notification device and account preference | Auth account ID |

`public.group_participants` holds the stable `(group_id, id)` and an optional `auth_user_id`. Existing memberships are backfilled without changing their ledger IDs. An unjoined person's participant ID is distinct from any future account; no placeholder Auth user or profile is created. The private contact record binds that place to the intended email.

The database allows one participant per account in a group. Claiming requires the matching verified Google identity, a valid invitation and the latest review digest. Group and invitation locks make the account binding and membership change atomic. The ordinary member-add route cannot bypass a pending place, and a separate existing ledger identity causes a conflict instead of an automatic merge. Resolving such a conflict or transferring a place to a different email is not an organiser self-service feature in this version.

The v4 group snapshot supplies `my_participant_id`, each participant's nullable account ID, status and eligibility flags. The UI uses ledger IDs for money and real account IDs for permissions, actor names and photos. Pending people have initials only and cannot act, receive private photos or access a group before joining.

## Expiry, replacement and uncertain saves

An expired or revoked invitation keeps all earlier records but removes the person from choices for new expenses. Archiving the group or losing the original inviter's organiser access also makes the invitation unusable. None of these events deletes a balance.

An authorised organiser can reissue an invitation for the same Google email in the same group. Pact reuses the unclaimed participant and their records, creates a fresh link, and invalidates the previous unused link. It does not rename or recreate the historical place. Do not create a differently addressed person to work around a mistaken email; that would be a separate ledger identity.

The inclusion form keeps a stable request ID and token in memory while the result is uncertain. **Check inclusion** repeats that request safely. Keep the form open until it is confirmed. The database stores a token hash, not a recoverable link; after leaving the form, a replacement may be needed to share it again. Optional email retries use their own immutable delivery receipt and never create another participant. See [invitation emails](INVITATION-EMAIL.md).

## Repayments and notifications

Expenses can include an unjoined person, but repayments cannot. Both repayment endpoints must resolve to joined accounts with current access. The recipient's account still controls their own approval preference.

If any unjoined person has a nonzero balance, the app pauses all suggested repayments. It does not omit that person and recompute an incomplete settlement. Current members can still record an actual payment between themselves. Joining preserves the ledger and makes suggestions available once no unjoined balance remains.

The optional notification compatibility update maps financial participant IDs to real accounts before enqueueing. It excludes the actor, suppresses unjoined people and retains device, session, preference and current-membership checks. Claiming a place does not send historical transaction alerts. The update does not install or enable notification delivery; production notifications remain disabled.

## Migration and client compatibility

Start from a tested backend with the direct-trip invitation migration installed. Inspect which optional modules are actually present, preserve a database backup and validate the upgrade in staging. Do not rerun older migrations or use a blanket migration push on an environment whose manually applied history has not been reconciled.

The new files, in repository order, are:

1. [`20261101030742_invitation_email_delivery.sql`](../supabase/migrations/20261101030742_invitation_email_delivery.sql) — optional email delivery metadata; it does not configure a sender or enable mail.
2. [`20261101031522_pending_group_participants.sql`](../supabase/migrations/20261101031522_pending_group_participants.sql) — participants, invitation review/claim, v4 snapshots and financial compatibility. Pending participants do not depend on the email service.
3. [`20261101031706_participant_notification_compatibility.sql`](../supabase/migrations/20261101031706_participant_notification_compatibility.sql) — updates an already installed notification module; otherwise does nothing.

Apply the relevant database changes before publishing the matching frontend. If notifications are installed later, apply their participant compatibility update before enabling delivery; the older enqueue function assumes financial IDs are account IDs.

Existing groups whose participants still use their original account IDs remain readable through older snapshot APIs. Once a group contains an unclaimed person or a claimed participant with a distinct ledger ID, those APIs return a refresh requirement. Older invitation acceptance cannot bypass the new review step. A frontend rollback does not remove these guards or undo the database migration, and an older client cannot safely display the new groups. Refresh open clients after rollout; retain records and use a compatible frontend for recovery.

## Privacy and verification

Pending contacts, invitation tokens and real group data do not belong in public source, screenshots or test fixtures. Clients cannot directly read/write the participant or contact tables. Authorised members receive the scoped snapshot; invitation addresses remain organiser-only. Before joining, the recipient's preview exposes their own summary, not the household directory or other participants' transactions. Pending participant IDs are never treated as accounts for profile-photo access or push delivery.

Hosted staging passed the rollback-only database smoke test on 1 November 2026; all 36 inspected functions matched source and no synthetic users or groups remained. This does not confirm production deployment.

Local database tests cover fresh accounts, exact splits, refunds, unchanged balances after claim, wrong/unverified accounts, stale reviews, conflicts, expiry/reissue, repayment permissions, optional-module combinations and notification suppression. Browser scenarios use synthetic people, including an account whose participant ID differs from its Auth ID. These checks establish local behaviour; they do not prove production migration, independent-connection race behaviour, inbox arrival or phone delivery. Consult [STATUS.md](STATUS.md) and the [deployment guide](DEPLOYMENT.md) for the recorded rollout state.

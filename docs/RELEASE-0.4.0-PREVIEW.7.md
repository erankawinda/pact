# 0.4.0-preview.7 — Invite friends to a trip

Prepared on 1 November 2026. The database upgrade is installed in production; frontend publication and final asset verification are pending.

## What changes

Trip organisers can open **People & trips → Invite a friend**, enter the friend's Google email and share a personal invitation link. New and existing Pact users can join that trip without joining its linked household. The existing household-member picker remains separate.

Invitations expire after seven days and require the intended Google account. Acceptance checks the group, inviter and link again. A trip-only organiser can invite people to their trip without seeing the household directory. Revocation removes access while retaining financial history; a fresh invitation grants returning guests member access.

Joining grants access to the selected trip's existing ledger and participants. It grants no household membership or access to other trips. There is no global Friends directory or separate event type; activities use trip groups. See [trip invitations](TRIP-INVITATIONS.md).

## Upgrade

Apply `20261101014329_direct_trip_invitations.sql` before publishing this frontend. Existing memberships and pending invitations default to their original household-bound access. The migration does not rewrite financial records. It updates installed photo, repayment and notification helpers without installing or enabling optional services.

Production retains profile photos enabled and transaction notifications disabled. Private deployment configuration and compiled bundles are excluded from this public source release. If an older optional module is installed later, prepare a new compatibility migration and rerun guest-access tests before enabling it.

## Validation

- Public privacy gate, 71 Node/database tests, TypeScript and the configured production build passed.
- All 42 isolated browser scenarios passed: 25 core, eight photo/account and nine notification scenarios.
- The exact migration passed hosted staging checks using actual database roles and synthetic fixtures. Fixtures were rolled back; cleanup confirmed no test guests or groups remained.
- Production schema and function compatibility were checked before applying the migration. No unrelated older migrations were rerun.
- Commit metadata and normal source history passed the private-value scan. No real household data, invitation tokens, photographs, production configuration or server secrets are included.

Actual fresh-account Google OAuth acceptance, simultaneous operations across separate PostgreSQL connections and native phone notification delivery remain unverified. Browser tests intercept external services; hosted database tests do not replace those checks. See [verification status](STATUS.md).

# Trip invitations

## Scope and rollout

The preview.7 database upgrade was verified in production on 1 November 2026. The frontend was published and all nine served files matched the reviewed package. This change introduces direct invitations to one trip without adding household membership. An activity such as a sports session uses the existing trip group; no separate event type is introduced.

There is no global Friends list. A Pact account is a person's identity and profile. Household and trip memberships determine what they can access. Creating an invitation does not create an account or add the recipient before they accept.

## Invite someone

1. Open the intended trip, then **People & trips**.
2. Choose **Invite a friend** and enter the Google email they will sign in with.
3. Create the personal link and share it privately. Pact does not send an email automatically.
4. They open the link, sign in with that Google account and accept. A person using Pact for the first time receives their account profile through sign-in.
5. They appear in that trip's people list and can participate in expenses, shopping and repayments there. The organiser can see or revoke pending invitations.

Links expire after seven days and match one intended email. Making a replacement link invalidates the previous unused link for that email and group. Someone receiving the wrong link can switch Google accounts without losing it.

Only an organiser can invite or manage people. An organiser who also belongs to the linked household retains a separate **Household member** picker for adding existing members. A trip-only organiser can invite friends but cannot load that household's member directory.

## Access boundaries

- Directly invited people see the selected trip's existing records, balances and participants. Access is to the group ledger, not only future or personally involved transactions.
- Joining a trip grants no household membership and no access to other trips. Joining a household alone still grants no access to its trips.
- Current co-members can see one another's display names and private profile photos. Account emails remain private except the intended email shown to organisers for pending invitations.
- Existing trip memberships and old pending invitations retain their household-bound access. Accepting another invitation while already active does not change that access basis or role.
- Revoking trip membership removes access while preserving spending history. Rejoining through a fresh invitation grants member access, not a previously held organiser role.
- Removing a household member retains the existing linked-trip removal behaviour and invalidates affected pending links. An organiser must issue a fresh invitation for a later return.
- Acceptance checks that the inviter still has organiser access and that the group remains open. A pending link cannot restore access after its relevant revocation.
- Optional notification delivery and photo reads use the same effective membership boundary. Actual phone delivery remains a separate, unverified acceptance check.

## Database and deployment

Apply `20261101014329_direct_trip_invitations.sql` after the existing core workflows. Existing rows default to household-bound access; no financial records are rewritten. Optional photo, notification and extended-repayment helpers are updated only when installed, so the feature does not require enabling those services.

Fresh installations apply migrations in filename order. For an existing deployment that skipped an older optional module, installing that module later can restore its old membership helper. Prepare a new compatibility migration after installing it; do not enable it until guest access and revocation tests pass. Do not rerun unrelated old migrations on production to enable invitations.

Validate on a separate test project before publishing the frontend. Use only synthetic users and transactions. Confirm that a guest can join and participate, cannot read the household or another trip, and loses access when removed. Check expired, revoked and wrong-account links, guest-organiser permissions and existing household-bound memberships. Keep production notification settings unchanged.

## Verification

Verified on 1 November 2026:

- Public-source privacy check, 71 Node tests, TypeScript and the Vite build passed. Ten database scenarios specifically cover direct invitations and compatibility with deployments that have not enabled optional modules.
- All 42 isolated browser scenarios passed: 25 core, eight photo/account and nine notification scenarios. The new guest flow covers invitation creation, first group acceptance, absence of household access and a guest organiser who never requests the household directory.
- The migration was applied to Pact Staging. The rollback-only [hosted smoke test](../tests/trip-invitations-hosted.sql) passed with actual database roles, including invitation creation before the friend has a profile, guest participation, revocation and safe rejoining. Cleanup checks found zero remaining test groups or test guests.
- New private helpers deny direct execution by anonymous and authenticated clients. Hosted security advisors reported no new findings; existing private-table policy notices and the pre-existing password-protection notice remain.
- Concurrency lock ordering was independently reviewed, but simultaneous operations across separate PostgreSQL connections were not exercised. Real Google sign-in and real-device notification delivery remain separate acceptance checks.

Production post-upgrade checks matched all 12 relevant functions, 36 columns and 27 constraints to tested source. Private helper grants and direct table-write restrictions remain intact. The production frontend matches the reviewed preview.7 package. No real household information, live invitation tokens, email addresses or photographs were used as fixtures or added to source.

# Profile and appearance preview

Version: **0.4.0-preview.1**. This is a development preview, not a deployed release.

This branch adds a small account profile to the existing household app. It is prepared independently of the separate 0.3.1 custom-share auto-fill update. That update's source must be reviewed and integrated before a combined release is built.

## Included

- Edit your own display name, with whitespace trimmed and a limit of 1–80 Unicode characters.
- See your initials avatar, signed-in Google email and role in the current household or trip.
- Choose System, Light or Dark appearance. The choice is stored on this browser.
- Keep the existing account-switching, sign-out and Home Screen guidance.

Display names are shared with authorised fellow members and are used throughout current records, history and exports. Changing a name does not change the immutable user ID, membership, roles, expenses or balances. The Google email remains read-only and is shown in the owner's account screen; it is not added to the shared profile table. Organisers can already see intended addresses for pending invitations.

Profile photos, contact information, banking details and online-presence tracking are outside this preview.

## Verification

On 6 October 2026, `npm run check` passed all 16 Node/database tests, TypeScript validation and the Vite build. `npm run test:browser` passed all 14 scenarios, including profile/theme accessibility checks and layouts at 320, 390 and 768 pixels. The existing household scenarios also passed. Profile screens were visually inspected in light and dark appearance.

These are local checks using synthetic accounts and a disposable PGlite database. They do not verify a hosted migration, Google sign-in, concurrent database connections or actual phone behaviour. Database function privileges and fixed search paths are asserted locally; hosted advisors remain a release check.

## Database and compatibility

The new profile migration adds an authenticated `update_profile(p_display_name)` operation. It derives the target user from the authenticated session and reuses Pact's verified-Google-user guard. It accepts no target user ID and grants no direct table writes.

The change is additive: old clients can continue to use the existing schema after the migration. Apply the new migration before publishing the new frontend. Rolling back the frontend does not require removing the profile function or undoing saved names.

The existing household refresh mechanism picks up changed names on other devices; profile changes are not a new Realtime broadcast feature.

## Release preparation

1. Review and integrate the independently supplied 0.3.1 source on its own branch.
2. Bring this profile work onto that verified base and resolve any conflicts explicitly.
3. Run `npm run check` and `npm run test:browser` on the combined source.
4. Test the additive migration in a development backend, then rehearse the two-account checks in [DEPLOYMENT.md](DEPLOYMENT.md#5-check-with-two-accounts-on-real-phones).
5. Build privately with the intended public connection values, retain the previous frontend deployment, and publish only the reviewed release.

Do not deploy the unconfigured build produced by a public-repository check. No production credentials or household records belong in this repository.

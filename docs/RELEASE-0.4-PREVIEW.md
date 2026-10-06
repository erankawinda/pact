# Auto-fill, profile and appearance preview

Version: **0.4.0-preview.2**. This is a development preview, not a deployed release.

This branch combines the reviewed 0.3.1 custom-share auto-fill source with basic profiles and device appearance preferences. The source integration preserves the repository's isolated browser fixture, dependency pins, privacy safeguards and previous timing fixes.

## Included

- Calculate one missing custom share from the total and entered amounts.
- Offer **Split remaining equally** when several selected shares are blank, preserving manually entered amounts and explicit zeroes.
- Recalculate editable **Auto** shares when the total, known amounts or participants change; retain the automatic choice through drafts and Review → Edit.
- Offer to use the sum of all explicit shares as the total when the total is blank or zero. Existing positive totals are never overwritten by this suggestion.
- Block invalid, over-precision and over-allocated splits; never produce a negative calculated share. Freeze exact shares before saving and retry the same request after uncertain responses.
- Edit your own display name, with whitespace trimmed and a limit of 1–80 Unicode characters.
- See your initials avatar, signed-in Google email and role in the current household or trip.
- Choose System, Light or Dark appearance. The choice is stored on this browser.
- Keep the existing account-switching, sign-out and Home Screen guidance.

Display names are shared with authorised fellow members and are used throughout current records, history and exports. Changing a name does not change the immutable user ID, membership, roles, expenses or balances. The Google email remains read-only and is shown in the owner's account screen; it is not added to the shared profile table. Organisers can already see intended addresses for pending invitations.

Profile photos, contact information, banking details and online-presence tracking are outside this preview.

## Verification

On 6 October 2026, `npm run check` passed all 21 Node/database tests, TypeScript validation and the Vite build. `npm run test:browser` passed all 16 scenarios, including custom-split and profile/theme accessibility checks and layouts at 320, 390 and 768 pixels. The existing household scenarios also passed. Custom-split and profile screens were visually inspected in light and dark appearance.

The added browser checks cover single and multiple missing shares, explicit zero, deriving a missing total, invalid and excess shares, mode and participant changes, background refresh, draft reload, Review → Edit, membership removal and frozen custom-share save retries. Source review found no blocking defect in the auto-fill implementation. This is bounded verification, not a claim that every possible application defect is eliminated.

These are local checks using synthetic accounts and a disposable PGlite database. They do not verify a hosted migration, Google sign-in, concurrent database connections or actual phone behaviour. Database function privileges and fixed search paths are asserted locally; hosted advisors remain a release check.

## Database and compatibility

The new profile migration adds an authenticated `update_profile(p_display_name)` operation. It derives the target user from the authenticated session and reuses Pact's verified-Google-user guard. It accepts no target user ID and grants no direct table writes.

The change is additive: old clients can continue to use the existing schema after the migration. Apply the new migration before publishing the new frontend. Rolling back the frontend does not require removing the profile function or undoing saved names.

The existing household refresh mechanism picks up changed names on other devices; profile changes are not a new Realtime broadcast feature.

## Release preparation

1. Run `npm run check` and `npm run test:browser` on the combined source after any further changes.
2. Test the additive profile migration in a development backend and run its database advisors. Auto-fill needs no database migration.
3. Rehearse the two-account checks in [DEPLOYMENT.md](DEPLOYMENT.md#5-check-with-two-accounts-on-real-phones), including real phone keyboards, custom amounts and profile edits.
4. Build privately with the intended public connection values, retain the previous frontend deployment, and publish only the reviewed release after the profile migration has been applied.

Do not deploy the unconfigured build produced by a public-repository check. No production credentials or household records belong in this repository.

# Auto-fill, profiles and appearance — 0.4.0-preview.2

Deployed **6 October 2026** as **0.4.0-preview.2**. The reviewed preview version identifier is retained for this household pilot.

This update combines the reviewed 0.3.1 custom-share auto-fill source with basic profiles and device appearance preferences. The source integration preserves the repository's isolated browser fixture, dependency pins, privacy safeguards and previous timing fixes.

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

Profile photos, contact information, banking details and online-presence tracking are outside this release.

## Verification

On 6 October 2026, `npm run check` passed all 21 Node/database tests, TypeScript validation and the Vite build. `npm run test:browser` passed all 16 scenarios, including custom-split and profile/theme accessibility checks and layouts at 320, 390 and 768 pixels. The existing household scenarios also passed. Custom-split and profile screens were visually inspected in light and dark appearance.

The added browser checks cover single and multiple missing shares, explicit zero, deriving a missing total, invalid and excess shares, mode and participant changes, background refresh, draft reload, Review → Edit, membership removal and frozen custom-share save retries. Source review found no blocking defect in the auto-fill implementation. This is bounded verification, not a claim that every possible application defect is eliminated.

The local suites use synthetic accounts and disposable PGlite databases. [GitHub Actions also passed on the deployed source commit](https://github.com/erankawinda/pact/actions/runs/37428554418) using Node.js 22.

Separate hosted validation on 6 October passed all 11 database check groups in an isolated staging project. These covered own-profile updates, co-member visibility, nonmember isolation, trusted identity checks, input boundaries, unchanged roles and ledger records, existing operations, function privileges and fixed search paths. Synthetic database fixtures were rolled back. Staging security advisors reported no errors or warnings.

Real Google sign-in then succeeded on staging. A display-name change persisted after reload, and the original name was restored and verified. Dark appearance persisted after reload, and the preference was restored to System. These browser checks used one real account; they do not establish independent-client concurrency or mobile accessibility.

The maintainer chose to skip two-phone and independent two-account acceptance for this release. Those checks were not run and are not counted as passes. See [deployment checks](DEPLOYMENT.md#5-verify-shared-workflows) for an optional follow-up using separate browser sessions or actual phones.

## Database and compatibility

The new profile migration adds an authenticated `update_profile(p_display_name)` operation. It derives the target user from the authenticated session and reuses Pact's verified-Google-user guard. It accepts no target user ID and grants no direct table writes.

The change is additive: old clients can continue to use the existing schema after the migration. Apply the new migration before publishing the new frontend. Rolling back the frontend does not require removing the profile function or undoing saved names.

The existing household refresh mechanism picks up changed names on other devices; profile changes are not a new Realtime broadcast feature.

## Deployment record

The deployed source is commit [`7fcd4f2`](https://github.com/erankawinda/pact/commit/7fcd4f27ad922c37e5ed857cc369111c9462e6d7). The profile migration was applied before the frontend; its installed function definitions match the validated staging definitions. Before/after fingerprints confirmed that the migration left all application-table contents unchanged. Auto-fill required no database migration.

The live HTML, JavaScript, CSS and web manifest matched the privately configured release bundle byte for byte. Response headers, the existing signed-in session, household loading and the new account settings were checked. No production test expenses were created. The previous frontend deployment remains available for rollback.

Configured bundles, environment identifiers, private verification logs and household records remain outside this repository. Public source checks produce an unconfigured build; publishing a fork requires that fork's own backend settings.

For future releases, repeat checks appropriate to the changes and record incomplete acceptance work explicitly. Deployment and source-control history are separate for a Direct Upload project; merging a pull request does not publish the site.

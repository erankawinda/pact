# Profile refresh and photo rollout — 0.4.0-preview.6

Prepared **11 October 2026**. The production photo backend is installed and checked. **The frontend package awaits upload**, so production account upload acceptance is still pending. Transaction notifications remain disabled in this production build.

## What changes

The earlier preview.4 production bundle included the new colours and navigation but no photo-upload feature. This build enables the existing private photo service and puts its controls directly beside the user's identity. The account page has a larger avatar, display name and actual household/trip role, followed by grouped preferences and private Google sign-in details. Photo tips live in an expandable section, and errors offer a status check before retrying.

The original photo stays on the device. Accepted sources are up to 25 MiB and 64 megapixels: JPEG, PNG, WebP and HEIC/HEIF when the browser can decode them. A centred square preview is prepared locally. Only a JPEG up to 512 × 512 pixels and 256 KiB is sent; the server independently decodes and re-encodes pixels to remove metadata. Unsupported HEIC files need exporting as JPEG.

The owner and current members of a shared household or trip can view the photo. The bucket is private, reads recheck membership, and there are no public or signed image links. A saved photo must be deleted before adding a replacement. Version-bound deletion and stable upload request IDs protect retries and account changes.

## Deployment

This is a selective photo rollout, not a notification rollout. Apply only the photo migration on an already current core backend, then deploy `profile-photo` with gateway `verify_jwt=true` and its mandatory Auth check. Build with photos enabled and notifications disabled. Do not apply every pending migration automatically: notifications need their own secrets, scheduler and acceptance checks. See the [deployment guide](DEPLOYMENT.md#upgrade-to-040-preview6-with-photos-only).

The maintainer's production backend has already received this photo migration and function. Its five function bodies match the validated staging source. The private bucket's JPEG/256 KiB limits and service-only grants were checked; anonymous and invalid-token HTTP requests returned 401. Existing ledger data is outside this migration's write scope. The configured frontend package and deployment identifiers remain outside Git.

After upload, reload Pact, verify Account shows **0.4.0-preview.6**, and use **Choose a photo → Save photo**. A frontend rollback can retain the additive photo schema and images; never delete Storage metadata or household records as an interface rollback.

## Verification and limits

- Public privacy gate, 61 Node tests, TypeScript and configured production build passed. The existing bundle-size advisory remains.
- Eight photo/account browser scenarios passed, including the actual file chooser, preview before save, interrupted-request recovery, delete-before-replace, stale versions and account switching. Layout/accessibility checks covered 320/390/768 widths in light and dark themes.
- The 24 existing scenarios were covered across the main run and a focused account rerun after a development-server reload interrupted the final appearance scenario.
- Nine notification browser scenarios passed after moving settings into the new account layout. Native delivery remains simulated.
- Fresh staging validation with gateway JWT checking passed for an ES256 synthetic Auth session: status/read 200, upload 201, deletion 200 and read-after-delete 404. All temporary account, session, lifecycle and Storage records were removed.

These checks extend preview.5's hosted co-member/outsider, revoked-membership, metadata and body-limit coverage. They do not prove a particular phone's HEIC decoding, native accessibility or simultaneous database races. Real production-account photo upload remains pending until the frontend is deployed. Real phone notification delivery is not part of this release and remains unverified.

An interrupted private upload can remain until the owner returns or maintenance removes it through the supported lifecycle and Storage API. See the [photo service guide](../supabase/functions/profile-photo/README.md) for recovery and cleanup.

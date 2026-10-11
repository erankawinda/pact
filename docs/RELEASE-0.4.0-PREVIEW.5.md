# Private photos and transaction notifications — 0.4.0-preview.5

Prepared **11 October 2026** as a **staging candidate**. The hosted staging backend was validated. Photos subsequently reached production in [preview.6](RELEASE-0.4.0-PREVIEW.6.md); transaction notifications remain in staging and delivery to a real phone remains unverified. The evidence below records this candidate's original validation.

## What changes

Account adds optional phone notifications for expenses, refunds and repayments that involve the signed-in person. The person making a change does not receive their own alert, and unrelated household, shopping and profile activity stays silent. Each person chooses their categories and a Friendly or Brief tone. Notifications use generic text without names, amounts, household details or photos; tapping opens Pact with the recipient's access checked again.

Notifications require explicit permission on each device. A private outbox records committed transaction events, combines the old and new participants of an expense correction, and checks membership, session validity and preferences again before dispatch. Temporary delivery failures retry, and expired endpoints are disabled. Account changes clear the device binding and subscription. The service worker handles push only; it adds no offline transaction queue or page cache.

Profiles can also show an optional photo to the owner and current members who share a household or trip. A trip's parent-household membership still applies. Users must delete the stored photo before adding a replacement. The phone prepares a square preview locally; only a JPEG up to 512 × 512 pixels and 256 KiB is uploaded. The server independently decodes and re-encodes it to remove metadata, then stores it privately. Reads require authentication and current access; the app creates no public or signed photo links.

The source picker accepts JPEG, PNG, WebP and HEIC when the device can decode it, up to 25 MiB and 64 megapixels. Unsupported HEIC files receive guidance to export a JPEG. Deletion, retries and uncertain uploads retain the same operation identifiers so a retry cannot remove a newer photo or silently replace an existing one.

This candidate includes preview.4's appearance. Existing ledger amounts, repayment approval preferences and settlement behavior are unchanged.

## Installation order

This is **not** a frontend-only upgrade. Follow the [deployment guide](DEPLOYMENT.md#upgrade-to-040-preview5) on a separate staging project first:

1. Apply the transaction notification, private profile photo and notification index migrations after the existing six migrations. Do not rerun installed versions.
2. Deploy the two Edge Functions with their reviewed authentication settings. Configure server credentials outside Git and outside the frontend bundle.
3. For production, create a separate VAPID key pair and scheduler token, configure Vault and Cron in that environment, and verify an authenticated dispatch invocation.
4. Build with the intended public connection settings, matching public VAPID key and feature flags. Enable each feature only after its backend checks pass.
5. Verify a real phone can receive a test and an involved transaction alert, then verify account switching and notification navigation before calling phone delivery validated.

See the [photo service guide](../supabase/functions/profile-photo/README.md) and [notification worker guide](../supabase/functions/dispatch-notifications/README.md) for exact configuration and recovery behavior. Configured bundles, actual project identifiers, private keys and upload instructions remain outside this repository.

For a frontend rollback, retain the additive migrations and stored photos. Disable the notification schedule separately if delivery must stop; reverting the page bundle does not remove installed service workers or cancel queued push messages. The earlier preview.4 bundle does not expose the new controls. Do not delete ledger records or Storage metadata to roll back the interface.

## Verification

| Check | Result |
|---|---|
| Node suite | **57 tests passed**: 30 existing tests, 9 notification database tests, 6 photo service tests, 4 image-header tests and 8 service-worker tests |
| Isolated browser suites | **39 scenarios passed**: 24 existing, 6 photo and 9 notification scenarios; includes both themes, narrow layouts and automated accessibility checks |
| Notification worker | Deno typecheck and **7 runtime tests passed** with synthetic provider responses and actual payload encryption |
| Hosted staging checks | **13 check groups passed**, including actual JPEG processing and Storage operations, permissions, replacement guards and cleanup |
| Hosted dispatcher | Unauthorized invocation returned **401**; authorized invocation returned **200** with an empty queue |
| Hosted schedule and source parity | Three scheduled responses returned **200**; all **30 reviewed function bodies** matched the final source |

Hosted photo checks exercised a 512-pixel image through decode, re-encode, upload, replay and deletion; replacement was blocked until deletion. Current co-member access worked, outsiders and revoked members were denied, direct browser Storage access was denied, metadata and body-size checks passed, and deletion left no corresponding stored object. Test records and images were synthetic and were cleaned up after validation; no test photo objects remained.

The staging security advisor's notices about private tables with RLS and no client policies reflect intentional denial of direct client access. Its existing password-protection warning concerns a password setting in an app using Google sign-in; this change did not introduce it. Neither notice is evidence of complete security coverage.

## Limits

An empty successful dispatch verifies scheduling and authentication, **not phone delivery**. Browser tests simulate native Push and Notification APIs. APNs, FCM and Mozilla delivery, lock-screen behavior, Focus/battery restrictions and a particular phone's HEIC support still require device checks. iPhone and iPad push requires iOS/iPadOS 16.4 or later and Pact installed on the Home Screen.

Database fixtures serialize requests. Retry and stale-operation coverage does not prove correctness under simultaneous PostgreSQL sessions. Independent multi-account Realtime delivery, native screen-reader use and a complete backup/restore rehearsal also remain outside the completed checks.

Push is best effort. A provider accepting a message does not prove it appeared on a phone; a crash after acceptance can lead to a retry. Stable topics and notification tags reduce duplicates without promising exactly-once delivery. A private unfinished photo may remain after an interrupted upload until the owner returns or maintenance removes it through the Storage API. These operational limits are described in the service guides.

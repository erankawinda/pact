# Private profile photo service

The frontend prepares a small JPEG locally. This function receives only that JPEG,
validates and decodes it, then re-encodes pixels without metadata before storing it.
The original photograph is never uploaded by Pact.

## Runtime and deployment

- Apply `20261011083917_private_profile_photos.sql` before deploying the function.
- Deploy this directory with its pinned `deno.json` imports.
- The function validates every caller using Auth `getUser(token)`, a verified email,
  and the trusted Google provider list. It does not trust decoded JWT claims alone.
- Projects using asymmetric signing keys can disable the gateway's legacy JWT check
  for this function only. The function's own Auth validation must remain enabled.
- `SUPABASE_URL` and the default key in `SUPABASE_SECRET_KEYS` are read only on the
  server. Older projects may use `SUPABASE_SERVICE_ROLE_KEY` instead.
- Keep the frontend feature flag disabled until hosted Auth, Storage and JPEG tests
  pass. The Node tests do not emulate the hosted function's CPU/memory limits.

## HTTP contract

All non-OPTIONS requests require `Authorization: Bearer <user access token>`.
The browser also supplies its normal Supabase `apikey` header to the API gateway.
No request accepts a user ID as the owner of a write.

- `GET ?user_id=<uuid>` returns JPEG bytes or 404. The requester must be the owner
  or an effective active member of a common household/trip. For trips, both people
  must also remain active in the parent household. Authorisation is rechecked
  after Storage returns the bytes.
- `GET ?status=1` returns the caller's state. An optional `user_id` must be their
  own ID. Ready: `{status:"ready",version:"uuid"}`. Empty: `{status:"empty"}`.
  Pending: `{status:"uploading"|"deleting",operation_id:"uuid",retry_at:"timestamp"}`.
- `POST` sends raw `image/jpeg` bytes and `X-Request-Id: <new uuid>`. The request ID
  becomes the image generation. A successful new upload returns 201 and ready
  state; a completed retry returns 200. A concurrent retry while the original
  request is running returns 202 and pending state, without starting another writer.
- `DELETE` requires a new `X-Request-Id` plus `X-Photo-Version`, taken from the ready
  version (or an expired upload's operation ID). Returns `{status:"empty"}`.
  Refresh status after an uncertain response. Replaying an old completed deletion
  does not remove a newer image.

Errors return `{error:"stable_code",message:"human-readable text"}`. All responses
are `private, no-store`. No public object URLs or signed URLs are generated.

## Limits and storage

Input and stored output are at most 262,144 bytes and 512 pixels on each edge.
The server accepts baseline, 8-bit, one- or three-component JPEGs, matching the
client's canvas output. It rejects other formats even if labelled image/jpeg.
`jpeg-js` is pinned to 0.4.4, uses strict decoding with a 16 MiB decoder allocation
limit and 0.262144 megapixel limit, and encodes only fresh pixel data. Native
phone/HEIC decoding occurs on the user's device, never in this function.

The bucket is private and has no browser Storage policies. Only this server proxy
uses Storage. The SQL RPC is executable only by `service_role`, and the handler
supplies its actor ID exclusively from the verified Auth response. The table owner
mapping is authoritative; service uploads do not have a user `owner_id`.

## Recovery and cleanup

A row lock serialises each owner's slot. A ready or deleting image must be removed
before another upload can reserve it. Object names are immutable per generation;
Storage uploads use `upsert:false`. Deletion hides the image before the Storage API
removes it; SQL refuses to clear the slot while Storage metadata still exists.

A timed-out upload may have committed. Do not immediately delete its object or
start a second writer. Check status first. The upload reservation lasts ten minutes,
longer than the documented maximum hosted worker lifetime of 400 seconds. After
expiry, a new upload first removes the old unfinished object through Storage and
clears the expired reservation. The owner can also remove it explicitly. An old
request ID can never recreate an image after deletion.

Storage and Postgres do not share a transaction. If a user never returns after an
interrupted upload, a private unfinished object may remain until a maintenance
cleanup or the next upload/removal. It cannot be read through this service. A
maintenance job should use the same expired-generation checks and Storage API;
never delete `storage.objects` rows directly. Administrative account deletion
should also remove that user's Storage folder before deleting the Auth user.

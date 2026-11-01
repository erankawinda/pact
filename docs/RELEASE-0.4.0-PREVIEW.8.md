# 0.4.0-preview.8 — include now, join later

Prepared in source and validated on the staging database on **1 November 2026**. This is not a production release record. Production remains preview.7; automatic invitation email is disabled pending a verified sender and controlled acceptance check.

## Changes

- Organisers can include an invited person inside People or an unfinished expense, then complete the split immediately. Uncertain inclusion retries keep one participant and one request.
- The intended verified Google account sees its own recorded amounts before joining. A changed summary requires another review. Joining attaches the account to the same group participant, preserving every amount and original actor; it does not approve historical charges.
- Pending and expired people are clearly marked. Reissuing to the same email preserves their place. Repayments require joined members, and settlement suggestions pause while any unjoined balance is nonzero.
- Optional invitation email has server-validated recipients, bounded sends, stable provider idempotency and visible sending/failure/uncertain states. Provider acceptance is distinguished from inbox arrival. Manual links remain available.
- Photos, organiser actions, shopping actors and notification recipients use actual account identities. Claiming never replays historical push events. A public-source privacy check now also rejects mail-provider keys.

## Verification

100 Node tests, TypeScript, build and public privacy checks passed. All 50 isolated browser scenarios passed, including mobile accessibility, exact-draft recovery, reviewed claiming, account/ledger identity separation and email retry states. The invitation worker passed 19 Deno tests.

The three new database migrations passed hosted staging validation. A rollback-only smoke test exercised actual roles without retaining synthetic accounts or transactions. All 36 inspected function definitions matched reviewed source. The staging email endpoint requires a JWT and rejects anonymous requests; sending remains unconfigured. No real email or phone delivery was exercised by automated tests.

## Rollout

Apply the inspected [selective upgrade](DEPLOYMENT.md#next-update-invitations-and-pending-participants) before the matching frontend. Existing optional modules and manually applied migration history must be checked first. Older clients must refresh to use groups with new participant identities; an incompatible frontend rollback cannot display those groups safely.

Keep `VITE_INVITATION_EMAIL_ENABLED=false` until the [email setup](INVITATION-EMAIL.md) is verified. Reuse existing service capacity; no paid plan or add-on is required by the implementation. Domain registration is separate. Production rollout, sender setup, actual inbox arrival and independent concurrent-session acceptance remain outstanding. Existing production photo and notification settings are unchanged by this prepared source release.

See [pending-participant details](PENDING-PARTICIPANTS.md) and [dated verification status](STATUS.md).

# Roadmap

Pact is a personal project built around the practical friction of living with other people: shared purchases, unclear balances and remembering who still needs to do what. The next steps prioritise dependable everyday use over a larger feature list.

## Validate the household pilot

- Complete the [two-account acceptance checks](DEPLOYMENT.md#5-verify-shared-workflows), including invitation acceptance, live updates and repayment confirmation. These were skipped for the current release; independent browser sessions can cover the shared workflows.
- Exercise simultaneous updates against separate PostgreSQL sessions.
- Check iPhone Safari, Android Chrome, Home Screen use, screen readers and enlarged text on actual devices.
- Define and practise a backup/restore procedure before relying on the app for long-term records.

## Improve contributor setup

- Add a reproducible local Supabase Auth/Realtime configuration.
- Measure the JavaScript bundle and split code where this improves phone startup without complicating the app.

## Planned product work

The [deployed 0.4.0-preview.2 update](RELEASE-0.4-PREVIEW.md) includes custom-share auto-fill, basic profiles and device appearance choices. Hosted migration validation and deployment checks passed; the remaining multi-account and device checks are listed above.

The next product priorities are:

- Saved expense and split templates for repeated bills, with review before each new expense is posted.
- A monthly household summary using the complete ledger, including corrections, refunds and confirmed repayments.
- Private receipt attachments with explicit access controls.
- Dispute flags and their resolution workflow.
- Pantry stock states separate from the shopping request list.
- A designed import/restore flow; the current JSON export has no matching importer.

These are planned directions, not shipped features or promised dates. Current scope and verification limits are in [STATUS.md](STATUS.md).

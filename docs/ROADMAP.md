# Roadmap

Pact is a personal project built around the practical friction of living with other people: shared purchases, unclear balances and remembering who still needs to do what. The next steps prioritise dependable everyday use over a larger feature list.

## Validate the household pilot

- Validate real phone notifications: explicit permission, background receipt, involved participants only, account switching, tapping an alert and phone Focus settings. Hosted scheduling and simulated browser APIs do not establish device delivery.
- Complete the [two-account acceptance checks](DEPLOYMENT.md#5-verify-shared-workflows), including invitation acceptance, live updates and repayment confirmation. These were skipped for preview.2; independent browser sessions can cover the shared workflows.
- Exercise simultaneous updates against separate PostgreSQL sessions.
- Check iPhone Safari, Android Chrome, Home Screen use, screen readers and enlarged text on actual devices.
- Define and practise a backup/restore procedure before relying on the app for long-term records.

## Improve contributor setup

- Add a reproducible local Supabase Auth/Realtime configuration.
- Measure the JavaScript bundle and split code where this improves phone startup without complicating the app.

## Planned product work

The verified production [preview.3 release](RELEASE-0.4.0-PREVIEW.3.md) adds recipient-recorded repayments and personal approval preferences. The [preview.4 appearance package](RELEASE-0.4.0-PREVIEW.4.md) is ready for upload. The next [preview.5 staging candidate](RELEASE-0.4.0-PREVIEW.5.md) adds optional transaction notifications and private photos with deletion before replacement. Its hosted backend checks passed; production and real phone delivery remain separate steps.

Before extending these features, validate phone delivery, rehearse recovery from interrupted photo operations and document routine private Storage cleanup. Keep notification categories limited to changes involving the recipient; add reminders only with a separate explicit opt-in.

The next product priorities are:

- A simple view of enabled notification devices, including a way to revoke an unavailable old device.
- Saved expense and split templates for repeated bills, with review before each new expense is posted.
- A monthly household summary using the complete ledger, including corrections, refunds and confirmed repayments.
- Private receipt attachments with explicit access controls.
- Dispute flags and their resolution workflow.
- Pantry stock states separate from the shopping request list.
- A designed import/restore flow; the current JSON export has no matching importer.

These are planned directions, not shipped features or promised dates. Current scope and verification limits are in [STATUS.md](STATUS.md).

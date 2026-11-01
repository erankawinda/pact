# Invitation emails

## Availability

Automatic invitation email is an optional service being prepared after preview.7. It is disabled by default. The current production preview creates a personal invitation link for the organiser to share. Creating a link alone does not send mail.

The new service requires a verified sending domain, server credentials, the database migration, and a deployed Edge Function. Enable the frontend only after a real test email has been accepted by the provider and its link has passed the acceptance checks. Local tests use synthetic people and a simulated mail provider; they do not establish inbox delivery.

## Using the feature

An organiser opens **People & trips**, chooses **Invite a friend** or **Invite a flatmate**, and enters the Google email the person will use. With email enabled, **Send invitation email** creates the personal invitation and submits it to the mail service. **Create a link instead** retains manual sharing.

The recipient opens the link, signs in with the invited Google account and accepts. A trip invitation gives access to that trip only, including its existing ledger, without adding household membership. The account and membership checks are unchanged from [direct trip invitations](TRIP-INVITATIONS.md).

| Status | Meaning |
|---|---|
| Link created / email not sent | A valid link exists; no confirmed email submission is recorded. |
| Sending | A send attempt is still in progress. |
| Email sent | The email provider accepted the message and Pact recorded its receipt. Inbox arrival and reading are not confirmed. |
| Send status unconfirmed | The result is uncertain, for example after a network interruption. Check status or retry the same invitation. |
| Could not send | A known failure prevented sending. Copy the link or resolve the service configuration. |

The organiser can see recorded email status under pending invitations after reloading. Status is separate from acceptance: a pending invitation has not yet been accepted even if its email was sent.

## Retry and replacement

Retrying an uncertain send uses the same invitation, provider idempotency key and frozen message details. It does not create another invitation. Requests are rate limited and concurrent attempts are fenced by a database lease.

The raw link is kept only in the form's memory and the outgoing request. The database retains a hash and limited delivery metadata, not a recoverable token or full message. If the form has been closed, it can show status but cannot recover the old link. Creating a replacement explicitly invalidates the previous unused invitation for that person and group.

Retries stop before the provider's 24-hour idempotency window expires. Pact does not silently send again after that cutoff. There is no unattended email queue or automatic background retry service in this version.

## Setup and verification

Follow the [Edge Function setup guide](../supabase/functions/invitation-email/README.md). Use separate staging and production sender configuration. Keep provider keys and service-role credentials in server secrets only; frontend environment variables are public.

Before enabling production:

1. Apply only the new invitation-email migration to a compatible staging database. Do not rerun older migrations on an existing project.
2. Configure a domain-restricted sending key, verified sender and fixed HTTPS app origin. Disable email open/click tracking for invitation links.
3. Deploy the function with gateway JWT verification and its own Auth validation enabled.
4. Verify permission failures, invalid/expired/revoked invitations, rate limits, interrupted sends and safe retries. Confirm normal link sharing still works with email disabled or unavailable.
5. Send a controlled staging invitation, inspect the provider receipt, and verify the intended Google account can accept only that group. Receiving-mail-server acceptance and recipient reading are separate observations.
6. Configure production independently and enable `VITE_INVITATION_EMAIL_ENABLED=true` only after the service is ready. Retain a previous frontend deployment for rollback.

Turn off the frontend flag and the worker's `INVITATION_EMAIL_ENABLED` switch to disable new sends. Leave invitation and delivery history intact. Email delivery does not change expense shares, balances, repayment approvals or membership before acceptance.

## Privacy and abuse protection

The server obtains the recipient, group and inviter from validated database records. The client cannot choose an arbitrary email body, sender, recipient or redirect address. Only current authorised organisers can send, and the original inviter must still have access. Delivery metadata is private; ordinary group members cannot read invitation addresses or provider IDs through this feature.

Invitation tokens, provider keys and raw provider errors must not appear in logs or public source. The service sends only the information needed to join the selected group; it does not include balances, household directories or transaction details. Signed delivery webhooks, bounce status and read tracking are not implemented in this version.

## References

- [Supabase: sending emails](https://supabase.com/docs/guides/functions/examples/send-emails)
- [Resend: verified domains](https://resend.com/docs/dashboard/domains/introduction)
- [Resend: idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)

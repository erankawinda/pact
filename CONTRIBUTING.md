# Contributing

Pact is a small personal project built around shared-house living. Keep changes understandable and tied to a specific user problem.

## Development

Follow the README and use your own development backend. Use fictional names and transactions for screenshots, tests and issue reports. Never use another household's records as fixtures.

Before submitting a change, run `npm run check`. Run `npm run test:browser` for UI, invitation, workflow or database changes. Explain any manual checks or untested behaviour in the pull request.

## Commit organisation

Each commit should describe one coherent change and why it matters. Keep unrelated work separate. Suitable subjects include:

- `feat(shopping): add a quantity reminder`
- `fix(expenses): preserve exact shares after editing`
- `test(payments): cover rejected repayments`
- `ci: verify the browser flows`
- `docs: explain local setup`

Include tests with the behaviour they verify for future changes. Avoid mixing formatting, generated output, personal setup and feature work in one commit. Use a short body when a subject alone cannot explain the reason or compatibility considerations.

## Database changes

Do not edit migrations that have already been applied. Add a new migration, verify access rules and financial invariants in a disposable database, and document compatibility with an already-open older frontend. The deployment guide explains the release order.

## Before pushing

Review `git diff --cached` and the changed filenames. Do not commit `.env.local`, real emails, invitation links, private screenshots, database dumps, production identifiers or exports. A `.gitignore` rule helps avoid accidents; it does not make an already tracked file private.

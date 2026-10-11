# Contributing

Pact is a small personal project built around shared-house living. Keep changes understandable and tied to a specific user problem.

## Development

Follow the README and use your own development backend. Use fictional names and transactions for screenshots, tests and issue reports. Never use another household's records as fixtures.

Before submitting a change, run `npm run check` for the privacy gate, Node tests, TypeScript and build. Run `npm run test:browser` for UI, invitation, workflow or database changes. Photo/account changes also need `npm run test:privacy-browser`; notification changes need `npm run test:notifications-browser` and the dispatcher checks in its service guide. Explain hosted/manual checks and untested behaviour in the pull request.

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

Run `npm run check:privacy`, then review `git diff --cached` and the changed filenames. Review every screenshot visually and update its reviewed hash only after confirming that all content is synthetic. Use GitHub's no-reply address for both commit author and committer metadata. Do not commit `.env.local`, real emails, invitation links, private screenshots, database dumps, production identifiers or exports. A `.gitignore` rule helps avoid accidents; it does not make an already tracked file private.

# Contributing

## Development setup

Use Node.js 22+, npm 11+, and Docker Compose.

```bash
npm ci
docker compose up --build
```

Run the complete local gate before opening a pull request:

```bash
npm run check
npm audit --audit-level=high
```

PostgreSQL integration tests run automatically in GitHub Actions. To run them locally, set
`TEST_DATABASE_URL` to an isolated database.

## Change expectations

- Keep state changes and their audit events in the same PostgreSQL transaction.
- Preserve lease owner, expiry, and generation checks on every task settlement.
- Use stable idempotency keys for any external effect.
- Add a forward-only SQL migration for schema changes.
- Add unit and PostgreSQL integration coverage for reliability behavior.
- Update the OpenAPI document, runbooks, and `.env.example` when public behavior changes.
- Never commit credentials or use real customer/payment data in tests.

Prefer focused commits with short imperative messages. Pull requests should explain the invariant
being preserved, operational impact, and validation performed.

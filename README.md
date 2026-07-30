# Sentinel

Sentinel is a durable workflow orchestration engine for multi-step operations that must remain
correct when workers crash, stall, or retry. PostgreSQL coordinates work and remains the source of
truth for workflow and task state.

The initial demonstration workflow is:

```text
validate order → charge payment → reserve inventory → send confirmation
```

## Why Sentinel exists

Calling these operations sequentially inside one request handler creates ambiguous failure states.
A worker might charge a payment and crash before recording success, or resume after its lease has
expired and overwrite a newer worker. Sentinel is designed to make those cases observable and safe.

The complete design combines:

- durable PostgreSQL tasks;
- time-limited worker leases;
- generation fencing for stale database writers;
- idempotency keys for external effects;
- exponential-backoff retries;
- reverse-order saga compensation; and
- an append-only event history.

See [the architecture guide](docs/architecture.md) and
[the state-machine specification](docs/state-machines.md) for the system design. Phase 2's tables,
constraints, and transaction boundaries are described in [the durable data model](docs/database.md).
The worker ownership protocol is explained in
[leasing and generation fencing](docs/leasing.md).

## Repository structure

```text
apps/
  api/          Fastify control-plane API
  dashboard/    Next.js operational dashboard
  worker/       Durable task worker
packages/
  config/       Validated environment configuration
  contracts/    Shared workflow and task contracts
  database/     PostgreSQL pool and migration runner
docs/           Architecture and behavior specifications
```

## Local development

### Requirements

- Node.js 22 or newer
- npm 11 or newer
- Docker with Docker Compose for the complete stack

Install dependencies:

```bash
npm install
```

Copy the environment template when you need local overrides:

```bash
cp .env.example .env
```

Run all quality checks:

```bash
npm run check
```

Start PostgreSQL and every Sentinel service:

```bash
docker compose up --build
```

The services will be available at:

- Dashboard: `http://localhost:3000`
- API: `http://localhost:4000`
- Database-aware health check: `http://localhost:4000/health`

## Workflow API

Create the demonstration workflow:

```bash
curl --request POST http://localhost:4000/workflows \
  --header 'content-type: application/json' \
  --data '{
    "name": "Order fulfillment",
    "payload": { "orderId": "order-42" },
    "steps": [
      { "name": "Validate order" },
      { "name": "Charge payment", "maxAttempts": 3 },
      { "name": "Reserve inventory" },
      { "name": "Send confirmation" }
    ]
  }'
```

The response contains the workflow projection, ordered tasks, and immutable event history. Retrieve
it later with:

```bash
curl http://localhost:4000/workflows/WORKFLOW_ID
```

To run the applications directly, start a PostgreSQL instance matching `DATABASE_URL`, apply the
migrations, and launch the development processes:

```bash
npm run db:migrate
npm run dev
```

## Current milestone

Phase 3 provides atomic PostgreSQL task claiming, time-limited worker leases, heartbeats, expired-task
recovery, and generation-fenced completion and failure. PostgreSQL integration tests reproduce the
stale Worker A / replacement Worker B timeline and prove that only the current generation can commit.

Phase 4 will add the workflow handler registry, enforce sequential step activation after completion,
and run the complete e-commerce demonstration workflow.

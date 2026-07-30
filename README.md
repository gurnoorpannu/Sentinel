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
[the state-machine specification](docs/state-machines.md) for the Phase 1 design.

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

To run the applications directly, start a PostgreSQL instance matching `DATABASE_URL`, apply the
migrations, and launch the development processes:

```bash
npm run db:migrate
npm run dev
```

## Current milestone

Phase 1 establishes the runnable monorepo, service boundaries, database migration system, shared
contracts, Compose environment, and the technical design that later phases will implement.

Phase 2 will add the durable workflow, task, attempt, and event schema plus the first workflow APIs.

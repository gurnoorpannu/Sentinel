# Sentinel

[![CI](https://github.com/gurnoorpannu/Sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/gurnoorpannu/Sentinel/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Sentinel is a durable PostgreSQL-backed workflow orchestration engine for multi-step operations that
must remain correct when workers crash, stall, retry, or race after losing a lease.

The demonstration workflow is:

```text
validate order → charge payment → reserve inventory → send confirmation
```

## Why it exists

Calling those operations sequentially inside an HTTP handler creates ambiguous failure states. A
worker can charge a payment and crash before recording success, or wake after its lease expired and
overwrite a newer worker. Sentinel separates the mechanisms required to make those cases safe:

| Mechanism                 | Guarantee                                                                |
| ------------------------- | ------------------------------------------------------------------------ |
| PostgreSQL queue          | Workflow, task, and audit state commit transactionally                   |
| Time-limited lease        | Another worker may recover work after the current owner disappears       |
| Generation fence          | A stale worker cannot settle a task after ownership changes              |
| Stable idempotency key    | Retried external effects return the original result instead of repeating |
| Retry policy              | Temporary failures back off and stop at an explicit attempt ceiling      |
| Saga compensation         | Completed reversible steps are undone in reverse order after failure     |
| Event-history replay      | The immutable history is checked against every live workflow projection  |
| Guarded operator controls | Manual cancel/retry commands are authenticated, versioned, and audited   |
| Bounded worker scheduler  | Concurrency scales without unbounded promises or PostgreSQL connections  |

Sentinel provides **at-least-once task execution**. It does not claim exactly-once execution across
PostgreSQL and arbitrary external services.

## Architecture

```mermaid
flowchart LR
    Browser["Next.js operations dashboard"] --> API["Fastify control-plane API"]
    API --> DB[("PostgreSQL durable queue")]
    WorkerA["Bounded worker A"] --> DB
    WorkerB["Bounded worker B"] --> DB
    WorkerA --> Effects["Idempotent external effects"]
    WorkerB --> Effects
    DB --> Events["Append-only event history"]
    API --> Metrics["Protected Prometheus metrics"]
```

Workers claim eligible rows with `FOR UPDATE SKIP LOCKED`. Every settlement matches task ID, lease
owner, unexpired lease, and generation. Workflow/task projection changes and their audit events
commit in the same transaction.

## Quick start

Requirements: Docker with Compose, or Node.js 22+ and npm 11+ for direct development.

```bash
git clone https://github.com/gurnoorpannu/Sentinel.git
cd Sentinel
docker compose up --build
```

Services:

- Dashboard: [http://localhost:3000](http://localhost:3000)
- API: [http://localhost:4000](http://localhost:4000)
- OpenAPI 3.1 contract: [http://localhost:4000/openapi.json](http://localhost:4000/openapi.json)
- Liveness: [http://localhost:4000/live](http://localhost:4000/live)
- Readiness: [http://localhost:4000/ready](http://localhost:4000/ready)

In another terminal, run the end-to-end demonstration:

```bash
npm run demo
```

The script creates an order workflow, follows it to a terminal state, verifies event-history
integrity, and prints the task attempts, generations, event count, and dashboard URL.

## API example

```bash
curl --request POST http://localhost:4000/workflows/ecommerce \
  --header 'content-type: application/json' \
  --data '{
    "orderId": "order-42",
    "customerEmail": "buyer@example.com",
    "totalCents": 1299,
    "currency": "USD",
    "items": [{ "sku": "sentinel-shirt", "quantity": 1 }]
  }'
```

Retrieve the complete projection and immutable history:

```bash
curl http://localhost:4000/workflows/WORKFLOW_ID
curl http://localhost:4000/workflows/WORKFLOW_ID/history-integrity
```

Metrics and operator routes are absent unless their server-side bearer tokens are configured. See
the [OpenAPI contract](http://localhost:4000/openapi.json) and
[operator controls](docs/operator-controls.md).

## Reliability proof

The test suite includes deterministic PostgreSQL scenarios for:

- two workers racing for one task;
- stale completion after lease expiry and generation change;
- crash after a payment effect but before task settlement;
- stable idempotency replay without a duplicate payment;
- heartbeat-free hangs and lease reclamation;
- retry scheduling and exhaustion;
- reverse-order compensation and compensation repair;
- optimistic-concurrency rejection of stale operator commands;
- event-history replay after recovery; and
- bounded concurrency, draining, fleet presence, and benchmark cleanup.

Run the complete local quality gate:

```bash
npm ci
npm run check
npm audit --audit-level=high
```

GitHub Actions runs the PostgreSQL integration suite, builds both production images, verifies their
non-root users, validates Compose, and smoke-tests the API and dashboard.

## Capacity benchmark

The benchmark exercises real PostgreSQL claim and generation-fenced completion transactions:

```bash
BENCHMARK_DATABASE_URL=postgresql://sentinel:sentinel@localhost:5432/sentinel_benchmark \
BENCHMARK_TASKS=250 \
BENCHMARK_CONCURRENCY=8 \
npm run benchmark:worker
```

The CI smoke profile completed 40 tasks with four slots at 158.72 tasks/second on an ephemeral
GitHub runner. This is a regression measurement, not a production capacity promise; details and
tuning guidance are in [scalability and capacity](docs/scalability.md).

## Repository

```text
apps/
  api/          Fastify API, probes, metrics, OpenAPI, operator controls
  dashboard/    Next.js workflow control room
  worker/       Bounded lease-aware task executor
packages/
  config/       Validated runtime configuration
  contracts/    Shared states and transition contracts
  database/     PostgreSQL repositories and forward-only migrations
deploy/
  kubernetes/   Hardened baseline workloads and migration job
docs/           Architecture, reliability, operations, and interview guides
```

Key documentation:

- [Architecture](docs/architecture.md)
- [State machines](docs/state-machines.md)
- [Leases and generation fencing](docs/leasing.md)
- [Retries and idempotency](docs/retries-and-idempotency.md)
- [Saga compensation](docs/compensation.md)
- [Chaos and recovery testing](docs/chaos-testing.md)
- [Production runbook](docs/production.md)
- [Scalability and capacity](docs/scalability.md)
- [Interview guide](docs/interview-guide.md)

## Production and releases

The repository includes minimal non-root service/dashboard images, read-only Compose and Kubernetes
workloads, dropped Linux capabilities, resource limits, readiness/liveness probes, external secret
references, and a one-shot migration job.

Semantic-version tags such as `v0.1.0` publish service and dashboard images to GHCR with SBOMs and
build-provenance attestations. Review the [production runbook](docs/production.md) before deployment.

## Scope

Sentinel is a portfolio/reference implementation. The downstream e-commerce services are simulated,
the bearer-token controls are a deployment baseline rather than enterprise identity, and the
Kubernetes manifests intentionally leave ingress, TLS, managed PostgreSQL, backup, and network
policy to the target environment.

## License

[MIT](LICENSE)

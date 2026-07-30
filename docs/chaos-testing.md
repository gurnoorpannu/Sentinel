# Chaos and recovery testing

The chaos harness proves Sentinel's reliability mechanisms under deterministic failure. It is
controlled rather than random so each scenario can be reproduced in CI and explained precisely.

## Failure modes

A task payload may contain a `sentinelFailure` plan with one of these modes:

| Mode                  | Injected behavior                                                          |
| --------------------- | -------------------------------------------------------------------------- |
| `retryable`           | Throws a retryable error for the configured number of attempts.            |
| `permanent`           | Throws a non-retryable error and begins terminal failure or compensation.  |
| `hang`                | Delays execution while disabling lease heartbeats.                         |
| `crash_before_effect` | Abandons the lease before invoking the handler.                            |
| `crash_after_effect`  | Executes the idempotent effect, then abandons the lease before completion. |

`attempts` limits how many claims receive the fault. `delayMs` controls the delay before injection.
After the configured attempts, the normal handler executes.

An injected crash returns the internal `abandoned` outcome. The worker does not complete or fail the
task, sets a distinct process exit code, and leaves the lease in PostgreSQL. After expiry, another
worker reclaims the task with a higher generation. A hang disables heartbeats, allowing the same
lease-expiry path to fence its eventual stale completion.

## Development chaos endpoint

The API exposes `POST /workflows/ecommerce/chaos` only when `CHAOS_MODE_ENABLED=true`. It is disabled
by default; Docker Compose enables it for the local demonstration stack.

Example:

```bash
curl --request POST http://localhost:4000/workflows/ecommerce/chaos \
  --header 'content-type: application/json' \
  --data '{
    "orderId": "order-chaos",
    "customerEmail": "buyer@example.com",
    "totalCents": 4200,
    "currency": "USD",
    "items": [{ "sku": "sentinel-shirt", "quantity": 1 }],
    "failure": {
      "target": "reserve-inventory",
      "mode": "retryable",
      "attempts": 2,
      "maxAttempts": 2
    }
  }'
```

The failure target is restricted to payment, inventory, or confirmation. Modes, attempts, maximum
attempts, and delays are validated before a workflow is created.

## Event-history verification

`GET /workflows/:workflowId/history-integrity` replays the append-only event stream and returns:

- event count and latest sequence;
- replayed workflow status;
- replayed status for every task;
- a `valid` integrity result; and
- sequence, reference, transition, counter, or projection issues.

The verifier detects missing sequence numbers, event counter drift, task events before creation,
invalid encoded statuses, and differences between replayed and live projections. The dashboard
shows the same report on every workflow detail page.

## PostgreSQL recovery proofs

The CI suite exercises the mechanisms together:

1. **Crash after payment:** the first worker creates the payment effect and abandons its lease. A
   later generation reclaims the task, receives the stored idempotent response, and completes with
   exactly one payment record.
2. **Heartbeat-free hang:** another worker reclaims the expired lease. The original generation's
   completion is rejected, while the current generation completes successfully.
3. **Retry exhaustion and compensation:** injected inventory timeouts schedule backoff until the
   ceiling, then the workflow refunds the already completed payment and ends `compensated`.
4. **Replay integrity:** every recovered workflow's event log reconstructs the same terminal
   workflow and task states stored in PostgreSQL.

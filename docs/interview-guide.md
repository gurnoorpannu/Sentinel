# Sentinel interview guide

## Resume bullets

- Built a PostgreSQL-backed durable workflow orchestrator in TypeScript with atomic task claiming,
  time-limited leases, generation fencing, exponential retries, stable idempotency keys, and
  reverse-order saga compensation.
- Proved crash recovery with failure-injected PostgreSQL integration tests covering stale-worker
  fencing, payment deduplication, retry exhaustion, compensation, and event-history replay.
- Shipped a responsive operations dashboard plus production-ready non-root containers, Kubernetes
  probes/resources/security controls, Prometheus capacity metrics, bounded concurrent workers,
  audited operator recovery, and reproducible PostgreSQL benchmarks.

## Two-minute explanation

Sentinel coordinates multi-step operations that cannot safely live in one HTTP request. PostgreSQL
stores workflows, ordered tasks, leases, attempt state, and an append-only event history.

A worker atomically claims eligible work with `FOR UPDATE SKIP LOCKED`, receives a time-limited
lease, and increments the task generation. If that worker pauses beyond its lease, another worker
can reclaim the task. Every completion or failure includes the original owner and generation, so the
stale worker's write matches zero rows.

That fence protects Sentinel's database, but not a payment provider. External-effect handlers also
use stable workflow/step/operation idempotency keys. A recovered worker therefore receives the
original payment response rather than charging twice.

Retryable failures use exponential backoff. Permanent or exhausted failures activate compensators
for completed reversible steps in descending step order. Every state change and corresponding event
commits in the same PostgreSQL transaction.

The chaos suite deliberately crashes after payment, hangs without heartbeats, and exhausts retries.
It proves recovery, then replays the event log and verifies it matches the live projection.

## Whiteboard timeline

```text
Worker A claims task, generation 1
Worker A charges payment with stable idempotency key
Worker A crashes before completing the task
Lease expires
Worker B reclaims task, generation 2
Payment provider returns the stored idempotent response
Worker B completes with owner B + generation 2
Any late generation-1 write is rejected
```

Keep leasing, generation fencing, and idempotency separate:

- lease: when another worker may try;
- generation: which worker may update Sentinel;
- idempotency key: whether an external effect may execute again.

## Design tradeoffs

- **PostgreSQL instead of Redis:** transactions keep queue state, workflow state, and events
  consistent, at the cost of lower extreme throughput and careful index/connection management.
- **Projections plus audit events instead of full event sourcing:** workers query simple current
  state; event replay is an integrity/diagnostic path rather than the normal read model.
- **At-least-once execution instead of exactly once:** arbitrary external effects cannot share a
  transaction with PostgreSQL, so the design combines fencing with downstream idempotency.
- **Explicit compensation instead of database rollback:** committed business effects need semantic
  reverse actions such as refunds and inventory release.

## Demonstration flow

1. Start the Compose stack and create a normal e-commerce workflow.
2. Show strict task ordering and the dashboard event timeline.
3. Create a `crash_after_effect` chaos workflow targeting payment.
4. Explain why the task remains leased after the injected crash.
5. Restart/scale a worker, wait for reclaim, and show generation 2 completing.
6. Query metrics and show one payment idempotency record.
7. Show the green event-history integrity result.
8. Run the retry-exhaustion scenario and show compensation ending `compensated`.

## Likely follow-up questions

- How would you partition very high queue volume?
- How would you prevent a non-idempotent third-party API from duplicating effects?
- What happens if PostgreSQL fails during a handler call?
- How do additive migrations preserve rollback compatibility?
- Which metrics would drive worker autoscaling?
- How do database-pool limits create backpressure inside each worker?
- Why are operator retries version-checked and generation-fenced?

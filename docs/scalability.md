# Scalability and capacity

Sentinel scales in two dimensions: multiple worker processes compete through PostgreSQL
`FOR UPDATE SKIP LOCKED`, while each process runs a bounded number of leases concurrently. Both
paths preserve the same owner, generation, expiry, and idempotency checks as single-task execution.

## Bounded concurrency

`WORKER_CONCURRENCY` controls active execution slots per worker and defaults to 4. The scheduler:

- claims only while a slot is available;
- keeps at most the configured number of handler promises and lease-heartbeat loops active;
- waits for a completion when saturated instead of polling PostgreSQL;
- stops claiming immediately when shutdown begins;
- drains all in-flight work within `SHUTDOWN_GRACE_PERIOD_MS`; and
- surfaces an unexpected execution failure only after sibling leases finish or the grace deadline
  forces process exit.

`DATABASE_POOL_MAX` must be at least `WORKER_CONCURRENCY + 2`. The reserved connections prevent
claiming, task settlement, and worker-presence reporting from deadlocking behind handler or heartbeat
traffic. Raising concurrency without measuring PostgreSQL connection and lock pressure is not a
safe scaling strategy.

## Fleet presence

Each worker upserts one `worker_heartbeats` row every `WORKER_HEARTBEAT_INTERVAL_MS` (5 seconds by
default). It reports stable worker ID, process start time, configured concurrency, occupied slots,
and whether the process is draining. Metrics treat a non-draining heartbeat as active for 30
seconds, providing room for transient database latency while aging out dead processes.

The protected Prometheus endpoint includes:

- `sentinel_workers`;
- `sentinel_worker_capacity`;
- `sentinel_worker_in_flight`;
- `sentinel_workers_draining`;
- `sentinel_claimable_tasks`;
- `sentinel_oldest_claimable_task_age_seconds`; and
- `sentinel_task_completion_rate`, a five-minute completion rate.

Capacity saturation is `sentinel_worker_in_flight / sentinel_worker_capacity`. Queue age should be
the primary autoscaling signal; a queue can require more workers even when CPU remains low because
handlers are waiting on downstream I/O.

## Reproducible benchmark

Run the real PostgreSQL claim and fenced-completion path against an isolated database:

```bash
BENCHMARK_DATABASE_URL=postgresql://sentinel:sentinel@localhost:5432/sentinel_benchmark \
BENCHMARK_TASKS=250 \
BENCHMARK_CONCURRENCY=8 \
npm run benchmark:worker
```

The script applies migrations, creates isolated one-step workflows, runs the bounded scheduler,
prints setup time, execution time, tasks/second, and p50/p95/max claim latency, then deletes only
the workflow IDs created by that run.

GitHub Actions runs a 40-task, four-slot smoke profile on every change. The July 30, 2026 run
completed 40 real claim/settle transactions in 0.25 seconds (158.72 tasks/second), with 248 ms p50
and 252 ms p95 claim age. This is a regression smoke measurement on an ephemeral GitHub runner—not
a production capacity promise. Compare results only on equivalent hardware, PostgreSQL settings,
network topology, task shape, and concurrency.

## Tuning sequence

1. Establish a target for oldest claimable task age.
2. Measure handler latency, database pool wait, connections, and lock contention.
3. Increase worker replicas before making a single process very wide.
4. Keep `DATABASE_POOL_MAX` within the managed PostgreSQL connection budget.
5. Increase per-worker concurrency gradually for I/O-bound handlers.
6. Re-run chaos recovery and the benchmark after each capacity change.

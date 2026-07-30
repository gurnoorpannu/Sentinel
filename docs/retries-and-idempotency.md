# Retries and idempotency

Phase 5 handles temporary downstream failures without hammering a struggling service or repeating a
successful external effect.

## Retry classification

Handlers distinguish retryable failures from permanent failures. A fenced failure update uses the
persisted attempt count and maximum:

- retryable with attempts remaining → `retry_scheduled`;
- permanent → `failed`; or
- retryable with no attempts remaining → `failed`.

A terminal forward failure either marks the workflow failed or starts compensation in the same
transaction. Compensation attempts use the same retry ceiling and scheduling rules.

## Exponential backoff

Workers calculate:

```text
min(maxDelay, baseDelay × 2^(attemptCount - 1) × jitter)
```

Defaults are a 1-second base, 30-second cap, and ±20% jitter. PostgreSQL stores `next_attempt_at`.
Workers cannot claim a scheduled retry before that time. On the next claim, the task receives a new
generation and `next_attempt_at` is cleared.

## Stable idempotency keys

External-effect handlers use:

```text
workflow_id:step_number:handler
```

The key deliberately excludes worker identity, attempt count, and generation. Every legitimate retry
of the same logical step therefore reaches the same record.

PostgreSQL advisory transaction locks serialize concurrent calls for a key. The first call stores the
request hash and response; later calls return the stored response without executing the effect again.
Reusing a key with different input is rejected.

## Why fencing is not enough

Generation fencing prevents a stale worker from updating Sentinel. It cannot reverse a payment made
before that worker crashed. The idempotency record protects the external effect, while the generation
predicate protects Sentinel's task state. Both mechanisms are required.

The crash-recovery test performs a payment, expires the worker before task completion, reclaims the
task with a new generation, and executes the payment handler again. The workflow completes with the
original response and exactly one durable payment effect.

# Sequential orchestration

Sentinel composes individually fenced tasks into a complete ordered workflow.

## Persisted handler identity

Every task stores a lowercase handler identifier such as `charge-payment`. Workers resolve that name
through a local handler registry. Workflow definitions remain durable data; executable functions do
not need to be serialized into PostgreSQL.

An unknown handler is treated as an execution failure and is recorded through the same lease and
generation fence as any other worker failure.

## Transactional advancement

When a worker completes task N, Sentinel performs the following in one transaction:

```text
fenced update of task N to completed
→ append task.completed
→ lock task N+1
→ update task N+1 from blocked to ready
→ append task.ready
→ commit
```

If N is the final task, the transaction completes the workflow instead:

```text
fenced update of final task to completed
→ append task.completed
→ update workflow from running to completed
→ append workflow.status_changed
→ commit
```

This boundary prevents two inconsistent outcomes:

- a completed task whose successor never becomes runnable; and
- a runnable successor whose predecessor was not durably completed.

Only `ready` tasks can be claimed, so workers cannot execute steps out of order.

## E-commerce demonstration

`POST /workflows/ecommerce` creates:

1. `validate-order`
2. `charge-payment`
3. `reserve-inventory`
4. `send-confirmation`

Each simulated handler validates its task payload and returns a concrete result:

- validation status and item count;
- charge identity and amount;
- inventory reservation identity and items; or
- confirmation identity and recipient.

The same order payload is included in each task for now. Passing prior-step results into later steps
can be added when workflow dataflow becomes a project requirement.

## Worker competition

While a task is leased, every later task remains blocked. Competing workers receive no claimable
task for that workflow. Once completion and activation commit, exactly one worker can claim the next
step through the same `SKIP LOCKED` claim protocol.

## Failure boundary

Handlers classify errors as retryable or permanent. Retryable failures schedule exponential
backoff; terminal failures either end the workflow or activate reverse-order compensation.
External-effect handlers use stable idempotency keys so recovery does not duplicate an already
completed effect.

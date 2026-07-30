# Saga compensation

Partially completed workflows have a durable rollback path. Compensation does not rewind the
database transaction or promise that the outside world never observed a forward action. Instead,
each reversible step declares an explicit business action that restores consistency.

For the e-commerce workflow, the reversible pairings are:

| Forward action      | Compensation action |
| ------------------- | ------------------- |
| `charge-payment`    | `refund-payment`    |
| `reserve-inventory` | `release-inventory` |

Validation has no external effect to reverse. Confirmation is the final step and is not reversible
in this demonstration.

## Failure path

When a forward task permanently fails, Sentinel performs the following work in one PostgreSQL
transaction:

1. records the task as `failed`;
2. finds the highest-numbered completed step with a compensation handler;
3. moves the workflow from `running` to `compensating`;
4. marks that step `compensating` in compensation execution mode; and
5. appends the matching workflow and task events.

If no completed reversible step exists, the workflow moves directly to `failed`.

After a compensation task completes, Sentinel selects the next lower completed reversible step in
the same transaction. When none remains, the workflow becomes `compensated`. This produces strict
reverse order:

```text
validate → charge → reserve → confirmation fails
                              ↓
                    release inventory → refund payment
```

Later blocked forward tasks never become eligible after the failure.

## Reliability guarantees

Compensation is normal durable work, not an in-process callback:

- workers claim it through PostgreSQL row locking;
- every claim increments the generation fence;
- heartbeats renew its time-limited lease;
- an expired lease can be reclaimed safely;
- retryable failures use delayed exponential backoff;
- exhausted compensation moves both task and workflow to `compensation_failed`; and
- every accepted change appends an event in the same transaction.

The forward and reverse effects use distinct stable idempotency keys:

```text
workflow-id:step-number:charge-payment
workflow-id:step-number:refund-payment
```

That prevents a refund from colliding with the original charge while ensuring a crashed worker can
repeat the refund request without applying it twice.

## Audit events

The compensation timeline includes explicit events such as:

- `task.compensation_ready`;
- `task.compensation_leased`;
- `task.compensation_retried`;
- `task.compensated`;
- `task.compensation_failed`; and
- `workflow.status_changed`.

The mutable workflow and task rows remain the operational source of truth. Events provide an
ordered audit trail for debugging and the future dashboard.

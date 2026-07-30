# Durable data model

Phase 2 introduces the operational model that later queue, retry, and compensation phases build on.
PostgreSQL owns both current state and the append-only audit history.

## Tables

### `workflows`

One row represents the current workflow projection.

| Column           | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `id`             | Durable UUID identity.                                                  |
| `name`           | Human-readable workflow name.                                           |
| `status`         | Current workflow state, protected by a database check constraint.       |
| `payload`        | JSON object supplied when the workflow is created.                      |
| `version`        | Monotonic projection version incremented by accepted state transitions. |
| `event_sequence` | Atomic counter used to order this workflow's events.                    |
| Timestamps       | Creation, update, start, and terminal-state times.                      |

### `tasks`

Each row is one ordered workflow step. `(workflow_id, step_number)` is unique, making the order
unambiguous.

The first task is created as `ready`; every later task begins as `blocked`. Lease, generation,
attempt, retry, and result columns are present now so later phases can implement queue execution
without redesigning the table.

The `handler` column stores the executable handler identity resolved by workers. Completing a task
and activating its successor—or completing the workflow after the final task—occur in the same
transaction.

Partial indexes support the future hot paths:

- selecting ready or scheduled tasks;
- recovering expired leases; and
- reading workflow tasks in order.

### `workflow_events`

Events are immutable audit records. Each event has a unique `(workflow_id, sequence)` pair. The
sequence is allocated by atomically incrementing `workflows.event_sequence`, which serializes
concurrent writers without relying on timestamps.

Creation produces:

1. one `workflow.created` event; then
2. one `task.created` event for each ordered step.

## Transaction boundary

Workflow creation performs all of these operations in one PostgreSQL transaction:

```text
insert workflow
→ append workflow.created
→ insert every ordered task
→ append every task.created event
→ reload the complete projection
→ commit
```

Any error rolls the transaction back. A caller therefore sees either the entire workflow and its
history or no workflow at all.

State transitions lock the workflow row with `SELECT ... FOR UPDATE`, validate the transition,
update the projection, and append the matching event before committing. Concurrent attempts are
serialized and only a transition valid from the latest committed state is accepted.

## Database constraints

The schema rejects:

- unknown workflow or task states;
- empty names;
- invalid step numbers;
- duplicate step numbers within a workflow;
- invalid attempt limits or counts;
- partial lease ownership;
- lease data on a non-leased task;
- retry times on a non-retrying task; and
- duplicate event sequence numbers.

Application validation gives clients useful errors, while these database constraints remain the
last line of defense.

### `idempotency_records`

This table stores one simulated external effect per stable key, including its operation, request
hash, and response. Advisory transaction locking prevents concurrent callers from executing the
same effect twice.

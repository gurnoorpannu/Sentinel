# Workflow and task state machines

The definitions in this document are implemented in `@sentinel/contracts`. Database transitions
introduced in later phases must use the same rules.

## Workflow states

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> running
    running --> completed
    running --> compensating
    running --> failed
    compensating --> compensated
    compensating --> compensation_failed
    completed --> [*]
    failed --> [*]
    compensated --> [*]
    compensation_failed --> [*]
```

| State                 | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `pending`             | Definition and ordered tasks exist, but execution has not started.            |
| `running`             | At least one forward task is eligible or executing.                           |
| `compensating`        | A permanent forward failure caused reverse actions to begin.                  |
| `completed`           | Every forward task completed successfully.                                    |
| `failed`              | The workflow failed and no completed reversible action requires compensation. |
| `compensated`         | All required reverse actions completed.                                       |
| `compensation_failed` | At least one reverse action exhausted its retry policy.                       |

All states except `pending`, `running`, and `compensating` are terminal.

## Task states

```mermaid
stateDiagram-v2
    [*] --> blocked
    blocked --> ready
    ready --> leased
    leased --> completed
    leased --> retry_scheduled
    leased --> failed
    retry_scheduled --> ready
    completed --> compensating
    compensating --> compensated
    compensating --> compensation_failed
```

| State                 | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `blocked`             | A preceding workflow step has not completed.              |
| `ready`               | The task is eligible to be claimed.                       |
| `leased`              | A worker generation currently owns a time-limited lease.  |
| `retry_scheduled`     | The last attempt failed and a future retry time is set.   |
| `completed`           | The forward action completed and its result was recorded. |
| `failed`              | The forward action exhausted retries.                     |
| `compensating`        | The reverse action is eligible or executing.              |
| `compensated`         | The reverse action completed.                             |
| `compensation_failed` | The reverse action exhausted retries.                     |

## Transition invariants

1. A task becomes `ready` only when every preceding step is `completed`.
2. Only a `ready` task whose scheduled time has passed may be leased.
3. Claiming a task always increments its generation.
4. A leased-task update must match task ID, lease owner, and generation.
5. Completing a task and activating the next task occur in one transaction.
6. A terminal forward failure prevents later forward steps from becoming ready.
7. Compensation runs only for completed reversible steps, in reverse order.
8. Every accepted transition appends an event within the same transaction.

## Event history

Events describe accepted changes such as `workflow.started`, `task.leased`, `task.completed`, and
`task.retry_scheduled`. They support audit and timeline reconstruction, but workers query the current
workflow/task projections rather than replaying the log during normal operation.

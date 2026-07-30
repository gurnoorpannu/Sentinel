# Operator controls

Sentinel exposes a deliberately small recovery surface for actions that require human judgment.
Commands are authenticated, version-checked, state-restricted, and committed in the same PostgreSQL
transaction as their audit record and workflow events.

## Security boundary

Set `OPERATOR_TOKEN` to a random value of at least 32 characters. If it is absent, the operator API
route is not registered. Requests require both:

```text
Authorization: Bearer <OPERATOR_TOKEN>
X-Operator-ID: stable.name@example.com
```

The dashboard never sends the bearer token to the browser. Its server-side route reads the token
from the dashboard process environment, adds it to the API request, and forwards the operator ID
separately for attribution.

A shared token is a deployable baseline rather than full identity-aware access control. In a larger
system, place the endpoint behind an identity proxy and derive `X-Operator-ID` from a verified
identity claim instead of accepting browser input.

## Supported commands

| Action               | Required workflow state | Effect                                                                 |
| -------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `cancel`             | `pending`               | Marks every unstarted task and the workflow `canceled`                 |
| `retry_failed_task`  | `failed`                | Adds one attempt, advances the generation fence, and queues the task   |
| `retry_compensation` | `compensation_failed`   | Adds one attempt, advances the fence, and resumes reverse-order repair |

Cancellation is intentionally limited to workflows that have never started. Sentinel refuses to
label a running workflow canceled because a leased worker may already be executing an external
effect. Running workflows must reach their normal success, failure, or compensation outcome.

Manual retry preserves the original task and idempotency identity. The new generation prevents an
old worker from settling it, while the stable external idempotency key prevents a repeated provider
effect.

## Optimistic concurrency

Every request supplies the workflow version currently visible to the operator:

```bash
curl -X POST http://localhost:4000/workflows/WORKFLOW_ID/operator-actions \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "X-Operator-ID: oncall@example.com" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "retry_failed_task",
    "reason": "The downstream dependency has recovered",
    "expectedVersion": 3
  }'
```

If another worker or operator changes the workflow first, Sentinel returns
`409 WORKFLOW_VERSION_CONFLICT` with the current version. The operator must reload and reassess the
new state rather than blindly replaying a stale command.

## Audit guarantees

An accepted command writes all of the following atomically:

- the task and workflow projection changes;
- task/workflow state-change events;
- an `operator.action_applied` event containing action, actor, reason, and both versions; and
- an `operator_actions` ledger row with the same attribution.

Rejected authentication, validation, version, or state checks do not create an audit row and do not
change the workflow. Event-history verification understands canceled tasks and continues to compare
the replayed history with the live projection after repairs.

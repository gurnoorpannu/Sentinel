# Operations dashboard

The dashboard turns Sentinel's durable projections and event history into an operator-facing
control room. Normal inspection is read-only, while explicit recovery uses only authenticated,
state-restricted commands.

## Workflow overview

The root dashboard loads the 100 most recently updated workflows and presents:

- total, in-flight, terminal-failure, and recovered workflow counts;
- status filters for active, completed, failed, and compensated work;
- search across workflow names, IDs, and order IDs;
- completed-step progress and active or failed task counts;
- projection versions and last-update times; and
- automatic refresh every 10 seconds with a manual refresh option.

Loading skeletons preserve the page structure while data arrives. Empty search results, an empty
database, and an unavailable Sentinel API each have distinct operator guidance.

## Workflow detail

Selecting a workflow opens its live projection. The detail page refreshes every five seconds and
shows:

- workflow state, durable ID, projection version, duration, progress, and total worker claims;
- every ordered task with its current state and forward or compensation handler;
- attempt ceilings, generation fences, current lease owner, and lease expiry;
- scheduled retry eligibility;
- persisted success or failure results;
- workflow payload fields; and
- event-history replay integrity; and
- the immutable event timeline in reverse chronological order.

Timeline treatments distinguish normal transitions, successful completion, retries, compensation,
and terminal failures without hiding the underlying event sequence or worker identity.

The integrity banner is computed independently from the projection. A verified result means event
sequences are contiguous and replay to the same workflow/task states. A divergence result lists the
specific sequence, reference, counter, or projection mismatch.

When `OPERATOR_TOKEN` is configured on both the API and dashboard server, the detail page shows the
single safe action for the current state: cancel while pending, retry a failed forward task, or
retry failed compensation. The browser submits operator identity, reason, and visible workflow
version to a server-only proxy, so the bearer token never enters client JavaScript. Conflicts force
a refresh instead of overwriting newer durable state.

## Service boundary

The browser calls same-origin Next.js routes:

```text
/api/workflows
/api/workflows/:workflowId
/api/workflows/:workflowId/operator-actions
```

Those routes proxy Sentinel's Fastify API through `SENTINEL_API_URL`. Docker Compose points that
server-only value at the internal `api` service, while direct local development defaults to
`http://localhost:4000`. A browser therefore never needs to know the container network topology or
receive cross-origin API access.

## Responsive behavior

Wide screens preserve the dense operations table and sticky audit timeline. Intermediate layouts
collapse secondary table fields and sidebar labels. Mobile layouts prioritize workflow identity and
status, stack metrics, and move the event timeline below the execution path. Keyboard focus,
reduced-motion preferences, touch targets, and semantic labels are included throughout.

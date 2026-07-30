# Production deployment and operations

Phase 9 turns Sentinel's verified orchestration core into a deployable service. The supplied
Kubernetes manifests are a secure baseline, not a substitute for environment-specific networking,
TLS, identity, backup, and policy controls.

## Runtime images

The multi-stage Dockerfile produces two targets:

| Target      | Contents                                                            | Default process                 |
| ----------- | ------------------------------------------------------------------- | ------------------------------- |
| `service`   | Production dependencies, API/worker packages, migrations, contracts | `node apps/api/dist/server.js`  |
| `dashboard` | Next.js standalone server and static assets                         | `node apps/dashboard/server.js` |

Both images use Node.js 22, run as the built-in non-root `node` user, and exclude source maps,
development dependencies, caches, and the other runtime's build output where practical. Worker and
migration workloads override the service image command with direct Node entrypoints so signals do
not pass through an npm wrapper.

CI builds both targets, verifies their runtime UID is non-root, validates Compose, and starts each
image for a smoke request.

## Health and shutdown

The API exposes three probe levels:

- `GET /live` proves the Node process can serve requests and never contacts PostgreSQL.
- `GET /ready` requires PostgreSQL, core tables, and migration `005_compensation.sql`.
- `GET /health` remains a backward-compatible database health check.

During shutdown, readiness immediately returns `503`. The API stops accepting connections and waits
up to `SHUTDOWN_GRACE_PERIOD_MS`; after the deadline it closes remaining connections. Workers stop
claiming new tasks, finish in-flight work if possible, and force-exit at the same deadline. A forced
worker exit leaves its lease to expire normally, preserving Sentinel's recovery model.

Kubernetes allows 35 seconds while the application grace period defaults to 30 seconds.

## Metrics

Set `METRICS_TOKEN` to at least 16 characters to register `GET /metrics`. Without the variable, the
route does not exist. Scrapers must send:

```text
Authorization: Bearer <METRICS_TOKEN>
```

The Prometheus text response includes:

- API request totals and cumulative duration by method, route, and status;
- workflows by durable status;
- ready, leased, retry-scheduled, and compensating tasks;
- expired leases;
- total workflow events; and
- durable idempotency records.

Recommended initial alerts:

| Signal                                             | Suggested condition                        |
| -------------------------------------------------- | ------------------------------------------ |
| `sentinel_expired_leases`                          | Greater than zero for 2 minutes            |
| `sentinel_workflows{status="compensation_failed"}` | Any increase                               |
| `sentinel_workflows{status="failed"}`              | Sustained increase above normal baseline   |
| API 5xx request rate                               | More than 2% for 5 minutes                 |
| Ready API replicas                                 | Fewer than the required availability floor |

## Operator recovery

Set `OPERATOR_TOKEN` to a random value of at least 32 characters to enable guarded cancel and retry
commands. Keep it in the same external secret manager used for database credentials, mount it only
into the API and dashboard, and rotate it after any suspected exposure. The dashboard uses the
token only in its server-side API proxy; it is never a `NEXT_PUBLIC_` variable.

Every action requires a named operator, a reason, and the workflow version the operator reviewed.
State preconditions and optimistic concurrency prevent a stale dashboard from applying an unsafe
command. See [operator controls](operator-controls.md) for the command matrix and audit guarantees.

## Kubernetes deployment

The manifests in `deploy/kubernetes` assume:

- a managed PostgreSQL instance;
- service and dashboard images already published;
- the `sentinel-secrets` Secret created outside source control; and
- cluster ingress/TLS configured by the target environment.

Build and publish immutable image tags:

```bash
docker build --target service -t ghcr.io/gurnoorpannu/sentinel-service:GIT_SHA .
docker build --target dashboard -t ghcr.io/gurnoorpannu/sentinel-dashboard:GIT_SHA .
docker push ghcr.io/gurnoorpannu/sentinel-service:GIT_SHA
docker push ghcr.io/gurnoorpannu/sentinel-dashboard:GIT_SHA
```

Copy `deploy/kubernetes/secret.example.yaml` outside the repository, replace both placeholders, and
apply it securely. Update the image tags in the workload manifests or through a Kustomize overlay.

Deploy in this order:

```bash
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f /secure/path/sentinel-secrets.yaml
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/migrate-job.yaml
kubectl wait --for=condition=complete job/sentinel-migrate -n sentinel --timeout=120s
kubectl apply -f deploy/kubernetes/api.yaml
kubectl apply -f deploy/kubernetes/worker.yaml
kubectl apply -f deploy/kubernetes/dashboard.yaml
```

The migration job is idempotent at the SQL-migration level. Delete the completed Job before
recreating it with a newer image and the same name.

## Scaling and rollbacks

API, worker, and dashboard deployments begin with two replicas. API/dashboard replicas are
stateless. Worker replicas coordinate only through PostgreSQL row locks, leases, and generation
fences, so scaling workers horizontally does not require partition ownership.

Scale based on queue age and ready-task count rather than CPU alone. Keep PostgreSQL connection
limits in mind: each Sentinel process can open up to 10 pooled connections.

For an application rollback, restore the previous immutable image tag. Database migrations are
forward-only; do not roll them back automatically. Additive schema changes should remain compatible
with the previously deployed application until the rollback window closes.

## Incident checklist

1. Check API readiness and PostgreSQL connectivity.
2. Inspect `sentinel_expired_leases`, retry-scheduled tasks, and terminal workflow counts.
3. Open the affected workflow in the dashboard and verify event-history integrity.
4. Confirm the active task generation and lease owner before restarting workers.
5. Never edit workflow/task rows manually without preserving an equivalent audit event.
6. If compensation failed, resolve the downstream dependency, reload the workflow version, and use
   the guarded compensation retry with a specific audit reason.
7. Preserve logs, workflow IDs, event sequences, and idempotency keys for the incident record.

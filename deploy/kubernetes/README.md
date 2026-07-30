# Kubernetes baseline

These manifests deploy Sentinel's API, worker, dashboard, and migration job into the `sentinel`
namespace. PostgreSQL and secrets are intentionally external.

Before applying:

1. publish immutable `sentinel-service` and `sentinel-dashboard` image tags;
2. replace `:latest` through a Kustomize overlay or release pipeline;
3. create `sentinel-secrets` from `secret.example.yaml` outside source control;
4. confirm the managed database accepts connections from the cluster; and
5. configure ingress and TLS for the dashboard/API services.

`kustomization.yaml` deliberately excludes `secret.example.yaml`. See
[`docs/production.md`](../../docs/production.md) for deployment order, probes, metrics, scaling, and
rollback guidance.

# Changelog

All notable changes to Sentinel are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- PostgreSQL-backed ordered workflow and task projections with append-only audit events.
- Atomic task claiming, time-limited leases, heartbeats, and generation fencing.
- Exponential retries, durable external-effect idempotency, and reverse-order saga compensation.
- Deterministic crash, hang, retry, and permanent-failure injection with recovery verification.
- Event-history replay and projection-integrity reporting.
- Responsive operations dashboard with authenticated, audited cancel and recovery controls.
- Liveness, readiness, graceful shutdown, protected Prometheus metrics, and worker fleet presence.
- Bounded worker concurrency, PostgreSQL pool backpressure, and reproducible throughput benchmarks.
- Non-root production images, hardened Compose/Kubernetes baselines, and container smoke tests.
- Tagged GHCR release workflow with SBOM generation and signed build provenance.

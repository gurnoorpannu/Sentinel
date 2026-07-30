# Security policy

## Supported version

Security fixes are applied to the latest commit on `main`. This is a portfolio project and does not
currently maintain multiple supported release branches.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/gurnoorpannu/Sentinel/security/advisories/new)
with:

- the affected endpoint, component, or image;
- reproduction steps or a minimal proof of concept;
- the expected security impact; and
- any suggested mitigation.

Do not include real credentials, payment data, or personal information. Acknowledgement and
remediation timelines depend on project availability; no production support SLA is offered.

## Security boundaries

- `OPERATOR_TOKEN` and `METRICS_TOKEN` are server-side secrets and must never use a `NEXT_PUBLIC_`
  environment name.
- The supplied bearer tokens are a deployable baseline, not a replacement for identity-aware access
  control, TLS, ingress policy, secret rotation, and network segmentation.
- Chaos endpoints must remain disabled outside controlled test environments.
- The included e-commerce handlers simulate downstream services and are not payment-processing
  integrations.

# Section 9 task contract

Make the smallest repair that takes the evaluator from exactly two primary findings
to `READY_FOR_HUMAN_REVIEW`.

The application below `app/` is read-only. You may change only:

- `chart/values.yaml`;
- `chart/values.schema.json`; and
- `chart/templates/deployment.yaml`.

The repaired package must reference the existing Secret
`inference-platform-backend-token` and key `token`; it must not create or
populate that Secret. Restore the worker's 10m CPU and 32Mi memory requests and
100m CPU and 64Mi memory limits. The schema must require the repaired values.

Preserve all role, API, authentication, probe, service-account, security,
service, label, and policy contracts. Do not edit the evaluator or policy to
make a finding disappear.

This task is static and plan-free. No Kind cluster, Kubernetes namespace, Helm release, image, apply, or destroy action is permitted.
Evaluator acceptance means ready for human review; it is not deployment
approval.

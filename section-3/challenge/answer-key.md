# Operator Challenge Answer Key

Use this key after you complete your own lifecycle table. A real organization
may divide responsibilities differently, but the boundary must remain explicit
and reviewable.

| # | Primary owner | Why this owner | Change lifecycle and evidence |
| --- | --- | --- | --- |
| 1 | Terraform | The queue and dead-letter queue are infrastructure resources with create, update, and delete lifecycles. | A platform change updates the module. Plan evidence shows separate resources for local, test, and production. |
| 2 | Terraform | Message retention is a property of the provisioned queue resource, not application retry behaviour. | A platform review changes the resource configuration. The plan shows the old and new retention values. |
| 3 | Terraform | Access policies are infrastructure resources attached to the queue and workload identities. | A permission change starts a platform and security review. Plan and policy checks show the exact access delta. |
| 4 | Helm | Worker replicas are a deploy-time workload setting supplied by the chart. Terraform does not need to own pod scaling. | A workload deployment changes the Helm value. Rendered manifests show the requested replica count. |
| 5 | Helm | The workloads need a non-secret queue endpoint reference at deploy time. The queue itself still belongs to Terraform. | A deployment consumes the environment-specific reference. Rendered manifests show the reference, not a credential. |
| 6 | GitOps | The chart and image revision are reviewed desired state promoted between environments. | Test evidence and approval start the production promotion. Git history shows the promoted immutable revisions. |
| 7 | GitOps | The production values revision is a promotion record. Helm interprets the values, while GitOps controls when the reviewed revision moves. | A successful test gate and human approval start promotion. The pull request and sync status provide evidence. |
| 8 | Application configuration | Retry count controls runtime processing behaviour and should be tested with application failure cases. It does not create the queue. | An application behaviour change updates configuration and tests. Retry tests show the final failed state after the limit. |
| 9 | Application configuration | Status transitions are part of the application's job state machine. | An API or worker behaviour change updates the state rules. Unit and integration tests show valid and rejected transitions. |
| 10 | Application configuration | Idempotency decides how application code treats repeated submissions. It is not an infrastructure retention rule. | An API behaviour change updates the rule. Tests show that the same key does not create an unintended duplicate job. |
| 11 | Secret management | The queue credential is a reusable secret value that needs protected storage, access control, audit, and rotation. | A rotation event creates a new secret version. Secret-manager audit records and a runtime read check provide evidence. |
| 12 | Secret management | The encryption key is a secret value with its own rotation and recovery lifecycle. It must not enter Terraform state or Git. | A security-controlled rotation starts the change. Key-version metadata and decrypt/re-encrypt checks provide evidence without exposing the value. |

## Value and reference boundary

A secret value stays in secret management. A non-secret secret reference, such
as a secret name, path, or version alias, may cross into Terraform output, Helm
values, or GitOps desired state when policy allows it. The API or worker uses
that secret reference to read the value at runtime.

This distinction matters: moving a secret reference does not authorize moving
the secret value. Reviewers should reject credentials, tokens, or encryption
keys stored in Terraform state, rendered manifests, Git, or command output.

## Review result

The table is a design answer, not an approval. Platform engineering,
application engineering, and security still review the complete design pack
before implementation begins.

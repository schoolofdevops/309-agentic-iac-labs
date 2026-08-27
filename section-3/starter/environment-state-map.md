# Environment and state ownership

## Environment map

| Environment | Terraform state | State owner | Queue boundary |
| --- | --- | --- | --- |
| local | `local/queue.tfstate` | Platform engineering | Local development only |
| test | `remote://platform/production` | Platform engineering | Test workloads only |
| production | `remote://platform/production` | Platform engineering | Production workloads only |

## Terraform state contents

| Field | Planned contents |
| --- | --- |
| Terraform state contents | Queue resource IDs, access policy IDs, job payload, job status, result data |

## Lifecycle ownership

| Lifecycle owner | Owns in this change | Does not own |
| --- | --- | --- |
| Terraform | Queue, access policy, and resource identifiers | Job payloads, job status, result data, or secret values |
| Helm | Queue endpoint reference, worker replica count, and deploy-time environment variables | Infrastructure lifecycle or promotion approval |
| GitOps | Reviewed Helm values and promotion between environments | Runtime job data or secret values |
| Application configuration | Retry limit, visibility timeout behavior, and job status transitions | Queue provisioning |
| Secret management | Queue credentials and encryption keys | Reusable secret values in Terraform state or Git |

## Trust boundaries

- Client traffic crosses the public API boundary.
- Queue traffic stays inside the workload platform boundary.
- Workers read secret values at runtime from secret management.

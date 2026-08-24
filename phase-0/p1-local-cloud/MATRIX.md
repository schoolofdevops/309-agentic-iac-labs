# P1 Local-Cloud Resource Matrix

This is the exact Phase 0 contract for the local Terraform/OpenTofu path. A listed Floci service is not sufficient; every operation below must have direct evidence.

| Domain | Terraform resource or API | Required proof |
|---|---|---|
| Object storage | S3 bucket, versioning, private-access controls | Create, read, change one property, destroy, refresh, and a second no-change plan |
| Queue | SQS queue | Create, read attributes, change one safe property, destroy, refresh, and a second no-change plan |
| Job state | DynamoDB table | Create, read schema, change a safe property where supported, destroy, refresh, and a second no-change plan |
| Identity | IAM role and least-privilege policy | Create, attach policy, inspect rendered policy, destroy, refresh, and policy assertions |
| Observability | CloudWatch log group and metric/alarm path only if supported | Create, read, destroy, refresh, and documented unsupported behavior |

## Safety contract

- The local endpoint is opt-in through an explicit variable.
- The configuration rejects a local endpoint without an explicit local-mode flag.
- The default path must not send fake local credentials to real AWS.
- No P1 test runs `terraform apply` or `tofu apply` against a real AWS endpoint.
- Cleanup destroys only resources with the P1 prefix and verifies that a subsequent plan has no managed-resource changes.

## Compatibility contract

Run each supported scenario with Terraform and OpenTofu. Record provider version, endpoint, lock-file changes, lifecycle result, refresh result, convergence result, and cleanup evidence. Treat any OpenTofu lock-file rewrite as a compatibility finding, not a harmless warning.

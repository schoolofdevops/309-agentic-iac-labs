# P1 Floci Compatibility Evidence

**Run date:** 2026-08-24  
**Environment:** development machine only; not the declared 8 GB learner baseline  
**Endpoint:** `http://localhost.floci.io:4566`  
**Emulator:** Floci 1.7.0  
**Provider:** `hashicorp/aws` 6.61.0

## What was exercised

The configuration is intentionally local-only. A plan needs both
`local_mode=true` and an explicit `local_endpoint`; its endpoint validation
accepts only `localhost:4566` or `localhost.floci.io:4566`. The local test
credentials are assigned only in that explicit mode.

Terraform completed this lifecycle against Floci:

1. Validate and plan eight resources: S3 bucket, versioning, public-access
   block, SQS queue, DynamoDB table, IAM role, inline least-privilege policy,
   and CloudWatch log group.
2. Create: `8 added`.
3. Read with the AWS CLI pointed explicitly at Floci. The bucket, `job_id`
   DynamoDB hash key, IAM policy, log group, and SQS timeout were returned.
4. Change the queue visibility timeout from `30` to `45`: `1 changed` in
   place.
5. Refresh and run a second plan: `No changes`.
6. Destroy: `8 destroyed`; `terraform state list` was empty, a destroy plan
   said `No objects need to be destroyed`, and direct API lists returned `[]`
   for every P1 prefix.

OpenTofu completed the same local lifecycle:

1. Validate and create the same eight resources: `8 added`.
2. Change the queue visibility timeout from `45` to `60`: `1 changed` in
   place.
3. Refresh and run a second plan: `No changes`.
4. Destroy: `8 destroyed`.

## Compatibility finding

`tofu init` preserved provider version 6.61.0 but rewrote the lock-file source
from `registry.terraform.io/hashicorp/aws` to
`registry.opentofu.org/hashicorp/aws` and replaced hashes. This is a tracked
compatibility difference. The repository therefore ignores generated lock files
for this Phase 0 harness; future learner modules must use separate per-tool
lock-file handling or a documented tool-specific checkout.

## Tool behavior note

`floci aws` manages the emulator but is not an AWS CLI proxy. Its rejection of
`floci aws s3api list-buckets` was expected after inspecting `floci aws --help`.
Read assertions used the installed `aws` CLI with explicit local endpoint and
test credentials instead.

## Not proven

- This is development-host evidence, not 8 GB baseline evidence.
- A CloudWatch metric/alarm resource was not tested. The log-group resource
  passed; metric/alarm support remains an explicit follow-up check.
- Timings include Floci's approximately 25-second SQS create/update and
  approximately 42-second SQS destroy waits; they are not yet learner-time
  estimates.

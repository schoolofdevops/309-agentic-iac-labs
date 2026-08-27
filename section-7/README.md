# Build Infrastructure with Terraform, OpenTofu, and AI Agents

In this lab, you will repair and run the local cloud foundation for the course
project. The foundation has object storage, a job queue, job state, worker
identity, and a worker log group.

The starter is valid Terraform. It is not yet safe to own. Its provider range
can select an unreviewed release, one connection output is exposed, and the
worker policy uses wildcard access. You will repair these three problems, then
prove one local lifecycle with Terraform and one with OpenTofu.

The local lifecycle creates disposable resources only inside Floci. The named
runner accepts only the approved local endpoint and an `s7-` resource prefix.
It checks every plan shape before applying the saved plan, records direct API
evidence, destroys the named resources, and verifies empty state and APIs.

Begin with the [platform request](request.md) and [portable task](task.md).

## Objectives

You will:

- read the five-module contract and its dependency graph;
- find three ownership and safety problems that syntax validation misses;
- repair the provider constraint, sensitive output, and worker policy;
- create the exact eight-resource local foundation;
- move one queue resource address without recreating the queue;
- review one in-place update and no-change convergence;
- compare Terraform and OpenTofu lock files and behaviour;
- keep state, evidence, cleanup, and production approval separate.

## Prerequisites

You need:

- the learner labs repository from Section 6;
- Docker running;
- Terraform 1.14, OpenTofu 1.12, Floci, AWS CLI, Node.js 20 or later, and Git;
- about 20 minutes for the two local lifecycle runs;
- one coding agent only if you want the guided agent path.

The final proof on the reference machine sampled Floci at 36.2 MiB for the
Terraform run and 61.83 MiB for the OpenTofu run. If your machine has less than
the 7 GB reference profile, continue unless Docker or a tool reports a real
failure. Close unrelated containers first if needed.

No real cloud account, real credential, model API key, GPU, Kubernetes cluster,
remote backend, or paid service is required.

## PART I - Understand the Foundation

### Confirm your location

Begin at the root of the labs repository.

```bash
pwd
```

Your path will be different. It should be the root of your labs clone.

List the Section 7 files.

```bash
ls section-7
```

[ Expected output ]

```text
README.md  challenge  compatibility-record.md  refactor-before  request.md  scripts  starter  task.md  tests
```

### Read the request and task

```bash
sed -n '1,180p' section-7/request.md
```

```bash
sed -n '1,260p' section-7/task.md
```

The task permits four learner-owned results: three repaired Terraform files and
the compatibility record. It does not permit changes to the lifecycle runner,
tests, Phase 0 fixture, or earlier sections.

### See the module boundary

```bash
sed -n '1,220p' section-7/starter/main.tf
```

The root module connects five owned components:

- storage owns three S3 resources;
- messaging owns the SQS queue;
- job state owns the DynamoDB table;
- identity owns the IAM role and policy;
- observability owns the log group.

The identity module reads the bucket ARN and queue ARN from module outputs.
Those references create implicit dependency-graph edges. A manual `depends_on`
is not needed.

### Inspect the resource-address move

```bash
sed -n '1,100p' section-7/starter/moved.tf
```

The old address is `module.queue.aws_sqs_queue.jobs`. The new address is
`module.messaging.aws_sqs_queue.jobs`.

A `moved` block changes Terraform's address binding. It does not ask the
provider to delete and recreate the queue. The lifecycle runner proves this
with the real plan before applying it.

## PART II - Find the Three Starter Problems

Run the author checker.

```bash
node section-7/scripts/check-foundation.mjs
```

[ Expected output ]

```text
Foundation contract: REJECTED (3 findings)
- provider.constraint: Replace the open-ended AWS provider range with the reviewed compatible constraint.
- output.sensitivity: Mark the local endpoint output as sensitive.
- identity.scope: Replace wildcard worker access with exact S3 object and SQS permissions.
```

The non-zero exit is expected. Read each source before repairing it.

### Provider selection

```bash
sed -n '1,100p' section-7/starter/versions.tf
```

`>= 6.0.0` allows a later provider release that this course did not test. A
version constraint and a generated lock file solve different problems. The
constraint defines acceptable versions. The lock file selects one exact build
and records checksums for one tool and registry source.

### Output handling

```bash
sed -n '1,140p' section-7/starter/outputs.tf
```

The endpoint is local and uses fake credentials in this lab, but connection
details should not be copied casually into generated output and logs. The
repair marks this output sensitive. Remember that sensitive output can still
be stored in state. Sensitive is display protection, not encryption.

### Worker identity

```bash
sed -n '1,240p' section-7/starter/modules/identity/main.tf
```

The worker needs object read/write and queue receive/delete/send. It does not
need every action on every resource.

## PART III - Repair the Candidate

### Instructor path with Codex

The instructor demonstrates Codex once from the labs repository.

```bash
codex
```

Give Codex this task:

```text
Read section-7/request.md and section-7/task.md. Run the Section 7 checker.
Edit only starter/versions.tf, starter/outputs.tf,
starter/modules/identity/main.tf, and compatibility-record.md. Constrain the
AWS provider to the reviewed 6.61 line, protect the endpoint output, and grant
only the required S3 object and SQS actions on the exact module resources.
Preserve all modules, resources, graph references, local-mode checks, and the
moved block. Do not run a lifecycle, plan, apply, destroy, state operation,
network call, or real cloud command. Show the diff and rerun the checker. Stop
for my review.
```

Review the proposed diff before accepting it. Claude Code, Goose, Cursor,
Copilot, VS Code, or another compatible coding agent can use the same task.
Manual editing is also supported.

### Manual editing path

If you edit manually, make these changes:

1. Set the AWS provider constraint to `~> 6.61.0`.
2. Add `sensitive = true` to the `local_endpoint` output.
3. Grant `s3:GetObject` and `s3:PutObject` on `${var.bucket_arn}/*`.
4. Grant `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:SendMessage` on
   `var.queue_arn`.
5. Complete the compatibility record after both lifecycle runs, not before.

Inspect your learner-owned diff.

```bash
git diff -- section-7/starter/versions.tf section-7/starter/outputs.tf section-7/starter/modules/identity/main.tf section-7/compatibility-record.md
```

Run the checker again.

```bash
node section-7/scripts/check-foundation.mjs
```

[ Expected output ]

```text
Foundation contract: PASS
Provider constraint: ~> 6.61.0
Sensitive endpoint output: yes
Worker policy: exact S3 object and SQS permissions
Next decision: local lifecycle requires separate human approval
```

### Optional recovery copy

Try the repair first. If you need the reviewed candidate, save your own work,
then fetch the pinned recovery branch.

```bash
git fetch origin section7-terraform-foundation-candidate
```

Restore only the four learner-owned files.

```bash
git restore --source=ca2a5fd324a8007cf14efc827d1edc9d25044fcb -- section-7/starter/versions.tf section-7/starter/outputs.tf section-7/starter/modules/identity/main.tf section-7/compatibility-record.md
```

Rerun the checker before any local lifecycle.

## PART IV - Review the Local Execution Boundary

### Check the installed tools

```bash
terraform version
```

```bash
tofu version
```

```bash
floci --version
```

```bash
aws --version
```

```bash
docker info --format '{{.ServerVersion}}'
```

If a required tool is missing, stop and install that tool. Do not replace the
local endpoint with real AWS.

### Read the local-mode gate

```bash
sed -n '1,220p' section-7/starter/provider.tf
```

The runner supplies both `local_mode=true` and the approved endpoint. The
provider assigns fake test credentials only in that explicit mode.

### Read the runner before using it

```bash
sed -n '1,360p' section-7/scripts/run-local-lifecycle.mjs
```

Confirm these controls in plain language:

- only Terraform or OpenTofu is accepted;
- only the two approved localhost endpoints are accepted;
- the output must be a new named temporary directory;
- commands use fixed argument arrays with no shell;
- the create plan must contain eight create actions;
- the moved plan must report the declared address move;
- the update must be exactly one in-place change;
- destroy must leave empty state and empty direct API results.

Running the lifecycle command is your explicit approval for this one disposable
local run. It is not approval for a real-cloud plan or apply.

## PART V - Prove the Terraform Lifecycle

### Start the local emulator

```bash
floci start --pull=never
```

```bash
floci wait
```

```bash
floci status
```

The status should report Floci 1.7.0 running and reachable on localhost.

### Run the named Terraform lifecycle

```bash
node section-7/scripts/run-local-lifecycle.mjs --engine terraform --source section-7/starter --output /tmp/s7-terraform-learner --endpoint http://localhost.floci.io:4566 --prefix s7-learner-tf
```

This run normally takes three to five minutes because local SQS create, update,
and destroy operations include waits.

[ Expected final output ]

```text
Section 7 lifecycle: PASS (terraform)
Resources: 8 created, 1 moved, 1 changed in place, 0 remain
Lock source: registry.terraform.io/hashicorp/aws
Evidence: /tmp/s7-terraform-learner/lifecycle-evidence.json
Decision: ready for human review; no production action approved
```

### Read the evidence

```bash
sed -n '1,320p' /tmp/s7-terraform-learner/lifecycle-evidence.json
```

Find these observations:

- `create_action_count` is 8;
- `initial_resource_count` is 8;
- `moved_from` and `moved_to` name the queue addresses;
- the update is `0 add, 1 change, 0 destroy`;
- all direct APIs found the named resources before destroy;
- all direct API lists are empty after destroy;
- `final_state_count` is 0;
- `human_approval_required` remains true.

## PART VI - Prove the OpenTofu Path

Run the same candidate in a separate temporary working copy.

```bash
node section-7/scripts/run-local-lifecycle.mjs --engine tofu --source section-7/starter --output /tmp/s7-tofu-learner --endpoint http://localhost.floci.io:4566 --prefix s7-learner-tofu
```

[ Expected final output ]

```text
Section 7 lifecycle: PASS (tofu)
Resources: 8 created, 1 moved, 1 changed in place, 0 remain
Lock source: registry.opentofu.org/hashicorp/aws
Evidence: /tmp/s7-tofu-learner/lifecycle-evidence.json
Decision: ready for human review; no production action approved
```

Read the compatibility evidence.

```bash
sed -n '1,320p' /tmp/s7-tofu-learner/lifecycle-evidence.json
```

Terraform and OpenTofu should select provider 6.61.0 and complete the same
local behaviour. Their lock sources and lock hashes differ. Do not let one tool
silently rewrite the other tool's lock in a shared working directory.

Now read and complete your compatibility record.

```bash
sed -n '1,260p' section-7/compatibility-record.md
```

## Checkpoint

Your Section 7 checkpoint contains:

- five small modules and eight local resources;
- a reviewed provider constraint and tool-specific lock observation;
- a protected output and least-privilege worker policy;
- a dependency graph and JSON-plan identity;
- a state-preserving queue address move;
- one in-place queue update and no-change convergence;
- Terraform and OpenTofu lifecycle evidence;
- empty state, direct API cleanup, and a human approval boundary.

Continue with the [plan review challenge](challenge/plan-review.md).

## Teardown

Remove only the two completed Section 7 evidence directories.

```bash
node section-7/scripts/cleanup-local-run.mjs /tmp/s7-terraform-learner
```

```bash
node section-7/scripts/cleanup-local-run.mjs /tmp/s7-tofu-learner
```

Stop Floci.

```bash
floci stop
```

```bash
floci status
```

The final status should say `exited` and `Reachable: no`. No local resource,
Terraform/OpenTofu process, state file, plan, or background service remains.

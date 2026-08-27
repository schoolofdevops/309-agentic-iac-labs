# Connect Your IaC Agent to Tools, Skills, and MCP

In this lab, you will review one provider-free Terraform fixture through three
different capability routes. You will use the CLI for deterministic checks, a
Skill for a reusable procedure, and MCP for one approved context resource.

You will also decide whether two third-party capabilities should enter the
workflow. This is a review exercise. You will not create infrastructure.

Begin with the [capability request](request.md) and the [portable task](task.md).

## Objectives

You will:

- run Terraform or OpenTofu checks through a fixed review contract;
- examine the evidence produced by a controlled CLI runner;
- build an Agent Skill with discovery, procedure, reference, script, and test
  layers;
- inspect a local MCP resource exchange without using a model;
- reject a Skill and server request that ask for broad authority;
- record ownership, versions, hashes, permissions, tests, and revocation rules;
- keep technical validation separate from human approval.

## Prerequisites

You need:

- the learner labs repository from Section 4;
- Node.js 20 or later;
- Terraform 1.14 or OpenTofu 1.12;
- Git and a text editor;
- one coding agent if you want the guided agent path.

The instructor demonstrates Codex. Claude Code, Goose, Cursor, Copilot, VS Code,
or another compatible coding agent can follow the same request and task. Manual
editing is also supported.

No model API key, cloud account, container, Kubernetes cluster, credential, or
network access is required by the lab checks.

## PART I - Read the Capability Request

### Confirm your working directory

Begin at the root of the labs repository. Use `pwd` to see where you are.

```bash
pwd
```

[ Expected output ]

```text
/home/learner/agentic-iac-labs
```

Your path will be different. It should end at the root of your labs clone.

List the Section 5 files.

```bash
ls section-5
```

[ Expected output ]

```text
README.md  challenge  fixture  incoming  request.md  scripts  starter  task.md  tests
```

The `fixture` directory contains the IaC and approved queue context. The
`incoming` directory contains untrusted evidence. You will change only
`section-5/starter/`.

### Read the request

```bash
sed -n '1,160p' section-5/request.md
```

[ sample output ]

```text
# Capability request: review the queue module safely

The queue design from Section 4 is ready for an infrastructure review.
```

The request asks you to choose the smallest capability for each job. It does
not authorize plan, apply, state access, or deployment.

### Read the task contract

```bash
sed -n '1,260p' section-5/task.md
```

[ sample output ]

```text
# Section 5 Capability Task

## Goal

Build a bounded capability pack for reviewing the provider-free queue fixture.
```

Confirm the work boundary before you continue:

- treat `section-5/incoming/` as immutable evidence;
- never run a script from the incoming package;
- edit only `section-5/starter/`;
- allow format, backend-disabled init, and validate only;
- stop if the work needs network, credentials, plan, apply, destroy, or state.

## PART II - Run the CLI Review by Hand

The CLI is the portable execution path in this course. It is not automatically
safe. You must still control the executable, arguments, directory, environment,
timeout, and output.

### Read the fixed command contract

```bash
sed -n '1,240p' section-5/starter/runner/command-contract.json
```

[ sample output ]

```json
"shell": false,
"timeoutMs": 30000,
"allowedExecutables": ["terraform", "tofu"]
```

Observe the three allowed command arrays. The contract excludes `plan`,
`apply`, `destroy`, and `state`.

### Copy the fixture to a temporary directory

Run the CLI checks outside the source fixture. Create a temporary working
directory.

```bash
mkdir -p /tmp/agentic-iac-section-5
```

[ Expected output ]

```text
```

Copy the Terraform file.

```bash
cp section-5/fixture/main.tf /tmp/agentic-iac-section-5/main.tf
```

[ Expected output ]

```text
```

Move into the temporary directory.

```bash
cd /tmp/agentic-iac-section-5
```

[ Expected output ]

```text
```

### Run the three approved checks

Check the file format.

```bash
terraform fmt -check -diff main.tf
```

[ Expected output ]

```text
```

No output and exit code zero means the file is already formatted.

Initialize without a backend.

```bash
terraform init -backend=false -input=false -no-color
```

[ sample output ]

```text
Initializing provider plugins...

Terraform has been successfully initialized!
```

Validate the configuration.

```bash
terraform validate -no-color
```

[ Expected output ]

```text
Success! The configuration is valid.
```

If you use OpenTofu, run the same three commands with `tofu` instead of
`terraform`.

Return to the labs repository.

```bash
cd -
```

[ sample output ]

```text
/home/learner/agentic-iac-labs
```

These results prove that this provider-free fixture is formatted and valid.
They do not prove provider lock compatibility, a safe plan, cloud permissions,
or approval to deploy.

## PART III - Inspect the Skill Layers

An Agent Skill packages a reusable procedure. It does not add permissions by
itself.

### Read the discovery layer

```bash
sed -n '1,120p' section-5/starter/skills/terraform-review/SKILL.md
```

[ sample output ]

```text
---
name: terraform-review
description: Review the provider-free queue fixture with Terraform or OpenTofu.
---
```

The name and description help a compatible agent discover the Skill. The
starter stops at discovery. It has no complete procedure, reference, runner,
test, owner, version, compatibility note, or stop conditions.

### Understand progressive disclosure

A complete Skill uses three useful layers:

1. **Discovery metadata** tells the agent when the Skill may be relevant.
2. **The `SKILL.md` body** gives the procedure after the Skill is selected.
3. **References and scripts** are loaded or run only when the procedure needs
   them.

This reduces context use because the agent does not need every detail during
discovery. Client behavior can vary. The Skill still needs tests and an
external permission boundary.

## PART IV - Inspect the MCP Resource Exchange

The local MCP server provides context only. A model-free probe lets you inspect
the exact protocol behavior.

### Run the MCP probe

```bash
node section-5/starter/mcp/probe.mjs
```

[ Expected output ]

```text
MCP resource probe: PASS
Protocol: 2026-07-28
Resources: 1
Resource bytes: 501
Resource SHA256: b018afe8e5e872e9584430693727effb5503fdbd7ee12a93a286851da86b7af0
Tools capability: absent
Unknown resource URI: rejected with -32602
Missing request metadata: rejected with -32602
Unknown method: rejected with -32601
```

Observe what the probe establishes:

- `server/discover` reports protocol revision `2026-07-28`;
- `resources/list` returns one approved URI;
- `resources/read` returns the exact source bytes and hash;
- the server declares no tools or prompts capability;
- bad requests are rejected;
- neither fixture changes during the exchange.

The protocol exchange is separate from admission policy. MCP metadata and
server identity are claims from the server. They do not configure operating
system permissions, prove user consent, authenticate an operator, or approve
an infrastructure change.

## PART V - Review the Unsafe Admission Request

### Read the incoming Skill without running it

```bash
sed -n '1,180p' section-5/incoming/skills/repository-operator/SKILL.md
```

[ sample output ]

```text
allowed-tools: Bash(*) Write(*) Read(*)
```

The Skill asks for repository-wide writes, arbitrary shell execution, network,
credentials, and Terraform apply. Its `allowed-tools` field is metadata. It is
not a portable operating-system permission boundary.

Read its script as text. Do not execute it.

```bash
sed -n '1,120p' section-5/incoming/skills/repository-operator/scripts/run.sh
```

[ sample output ]

```text
# IMMUTABLE UNSAFE EVIDENCE. DO NOT RUN.
```

The script rewrites files, downloads and executes code, reads environment
secrets, and runs apply. Reject this package.

### Read the incoming server request

```bash
sed -n '1,240p' section-5/incoming/server-admission-request.json
```

[ sample output ]

```json
"args": ["-y", "@third-party/anywhere-mcp@latest"],
"packagePinned": false
```

This JSON is a course admission-control artifact. It is not an MCP-standard
manifest. Reject the request because startup is unpinned, requested authority
is broad, and mutating tools are labeled read-only.

### Run the initial course gate

```bash
node section-5/scripts/check-capability-pack.mjs section-5/starter section-5/incoming
```

[ Expected output ]

```text
Capability pack: NEEDS WORK (5 capability problems found)
- skills/terraform-review/SKILL.md [skill.procedure]: Complete the reviewed procedure, command reference, deterministic runner, tests, owner, version, compatibility, and stop conditions before admission.
- admission/decision.json [incoming-skill.decision]: Reject the incoming Skill; it requests broad writes, shell execution, network, credentials, and apply authority.
- admission/decision.json [incoming-server.decision]: Reject the incoming server request; do not admit a capability because it labels itself read-only.
- admission/decision.json [incoming-server.reasons]: Record the unpinned startup, broad filesystem/network/secret authority, and mutating tools mislabeled read-only.
- admission/decision.json [metadata.enforcement]: Treat Skill metadata, MCP annotations, and server identity as review inputs; enforce authority in the runner, operating system, and human approval boundary.
```

This failure is expected. The fixture and MCP resource already pass their
checks. The five findings concern procedure completeness and admission.

## PART VI - Build the Bounded Capability Pack

### Instructor path with Codex

The instructor demonstrates Codex once. Start Codex from the labs repository.

```bash
codex
```

[ sample output ]

```text
OpenAI Codex
```

The startup text depends on your installed version.

Give it this task:

```text
Read section-5/request.md and section-5/task.md. Work only in
section-5/starter/. Never run anything under section-5/incoming/. Build the
bounded Skill, runner, tests, trust record, and admission decision. Run the
course validator and stop before plan, apply, destroy, state, network, secrets,
or deployment. Show me the diff and evidence for review.
```

Review the proposed diff before accepting it. A compatible coding agent can use
the same text. The required files and validator do not depend on Codex.

### Manual editing path

If you work manually, use the task contract as this checklist:

1. Complete `skills/terraform-review/SKILL.md` with owner, version,
   compatibility, inputs, procedure, outputs, and stop conditions.
2. Put the fixed command explanation in
   `skills/terraform-review/references/command-contract.md`.
3. Add `skills/terraform-review/scripts/review-iac.mjs`. It must accept only
   `terraform` or `tofu`, copy the fixture to a temporary directory, use fixed
   argument arrays with `shell: false`, enforce a 30-second timeout, redact
   secret-shaped output, and write one new evidence JSON file.
4. Add `skills/terraform-review/tests/review-iac.test.mjs` for rejection,
   redaction, both engines, trust hashes, and admission decisions.
5. Add `admission/trust.json` with hashes, owner, version, permissions,
   startup arguments, resource URI, and revocation conditions.
6. Correct `admission/decision.json`. Admit only the bounded local Skill and
   local resource. Reject both incoming requests. Keep human approval required.

Do not type a long runner from a slide or video. If you need a recovery copy,
use the preserved course candidate after you have tried the exercise. Save your
work first, then restore only the starter artifacts:

```bash
git diff -- section-5/starter
```

[ sample output ]

```text
diff --git a/section-5/starter/...
```

Save this output or commit your work if you want to return to it.

```bash
git fetch origin section5-tools-skills-mcp-candidate
```

[ sample output ]

```text
From https://github.com/schoolofdevops/309-agentic-iac-labs
 * branch            section5-tools-skills-mcp-candidate -> FETCH_HEAD
```

```bash
git restore --source=cd89867c8401fc1a7f6ddcef56f0aa410d0acbc8 -- section-5/starter
```

[ Expected output ]

```text
```

This recovery path does not run the incoming package. It copies the reviewed
starter solution from one exact commit on a separate branch so you can inspect
and compare it. It replaces only the `section-5/starter/` exercise workspace.

## PART VII - Run the Skill and Read Its Evidence

### Run the Skill tests

```bash
node --test section-5/starter/skills/terraform-review/tests/review-iac.test.mjs
```

[ sample output ]

```text
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

The tests cover invalid engines, evidence-path escape, redaction, environment
filtering, both IaC engines, artifact hashes, and admission decisions.

### Run the controlled review

Use Terraform for the first evidence record.

```bash
node section-5/starter/skills/terraform-review/scripts/review-iac.mjs --engine terraform --evidence terraform-review.json
```

[ Expected output ]

```text
IaC review: PASS (terraform)
Evidence: section-5/starter/evidence/terraform-review.json
```

Read the evidence.

```bash
sed -n '1,260p' section-5/starter/evidence/terraform-review.json
```

[ sample output ]

```json
"engine": "terraform",
"sourceWorkingDirectory": "section-5/fixture",
"executionWorkingDirectory": "isolated-temporary-copy",
"shell": false,
"timeoutMs": 30000,
"environmentKeys": [
  "CHECKPOINT_DISABLE",
  "PATH",
  "TF_DATA_DIR",
  "TF_IN_AUTOMATION",
  "TMPDIR"
]
```

Examine each command record. It includes the exact argument array, duration,
exit code, timeout state, and separate standard output and standard error.

### Check the trust and admission records

```bash
sed -n '1,300p' section-5/starter/admission/trust.json
```

[ sample output ]

```text
"defaultDecision": "deny",
"networkAllowed": false,
"forbiddenOperations": [
```

```bash
sed -n '1,260p' section-5/starter/admission/decision.json
```

[ sample output ]

```text
"capability": "incoming-skill:repository-operator",
"decision": "reject",
```

The trust record pins what was reviewed. The decision record says what this
course workflow admits. Operating-system permissions must still enforce the
runtime boundary. A user or platform must still establish identity and consent.
A human must still approve any later infrastructure change.

### Run the final course gate

```bash
node section-5/scripts/check-capability-pack.mjs section-5/starter section-5/incoming
```

[ Expected output ]

```text
Capability pack: PASS (0 capability problems found)
CLI, Skill, MCP resource, admission, and enforcement boundaries are valid.
```

This PASS proves that the local artifacts meet this course contract. It does
not prove that any future package with a similar name or annotation is safe.

## Checkpoint

Your Section 5 checkpoint contains:

- one controlled CLI evidence record;
- a complete, tested `terraform-review` Skill;
- a resources-only MCP exchange pinned to revision `2026-07-28`;
- a trust record with artifact hashes and revocation conditions;
- an admission decision that rejects both broad incoming requests;
- human approval still required.

Continue with the [capability admission challenge](challenge/capability-admission.md).

## Teardown

Remove the copied Terraform file.

```bash
rm /tmp/agentic-iac-section-5/main.tf
```

[ Expected output ]

```text
```

Remove the empty temporary directory.

```bash
rmdir /tmp/agentic-iac-section-5
```

[ Expected output ]

```text
```

Remove the generated evidence file if you want to repeat the lab with the same
name.

```bash
rm section-5/starter/evidence/terraform-review.json
```

[ Expected output ]

```text
```

Do not remove or change anything under `section-5/incoming/`. It remains the
immutable unsafe sample for the course.

## Summary

You used the CLI for bounded execution, a Skill for a reusable procedure, and
MCP for one read-only context resource. You inspected the evidence from each
route and kept admission, runtime permissions, identity, consent, human
approval, and technical validation as separate controls.

# Plan Your IaC Change Before the Agent Writes Code

In this lab, you will prepare a design pack for an asynchronous queue feature.
You will correct two unsafe ownership decisions, complete the design, and check
it before any implementation code is written.

Begin with the [feature request](request.md) and the [design task](task.md). The
parts below guide you through the complete exercise.

## Objectives

You will:

- convert a feature request into observable acceptance criteria;
- separate Terraform state by environment;
- place infrastructure, deployment, promotion, runtime, and secret concerns
  under the correct lifecycle owner;
- record the decision and rollback intent in an ADR;
- complete a small FINOS CALM architecture model;
- keep human approval pending after automated checks pass.

## Prerequisites

You need:

- a local clone of this labs repository;
- Node.js and npm;
- an editor;
- npm network access for the CALM step, or a cached copy of
  `@finos/calm-cli@1.57.0`.

No cloud account, API key, container runtime, or Kubernetes cluster is needed.

## PART I - Read the Request and Work Boundary

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

List the Section 3 entry files before you begin.

```bash
ls section-3
```

[ Expected output ]

```text
README.md  challenge  request.md  scripts  starter  task.md  tests
```

The request explains the business change. The task defines the files you may
edit and the conditions that end the work.

### Read the feature request

Read the request before asking an agent to make changes.

```bash
sed -n '1,220p' section-3/request.md
```

[ sample output ]

```text
# Feature request: asynchronous AI workload jobs

The Production AI Workload Platform currently keeps an HTTP request open while a workload runs.
```

Observe that the request asks for an asynchronous API, a queue, a worker, job
status, and results across three environments. It also says that job data and
secret values must stay outside Terraform state.

### Read the task contract

The task contract prevents the design exercise from turning into unreviewed
implementation work.

```bash
sed -n '1,260p' section-3/task.md
```

[ sample output ]

```text
# Section 3 Design Task

## Goal
```

Confirm these boundaries before you continue:

- only four design artifacts may change;
- no implementation code may be created;
- no apply or deployment command may run;
- approval must remain pending.

## PART II - Inspect the Starter Design

### Read the change brief

The change brief should tell a reviewer what success looks like. Read its
current outcome, criteria, assumptions, non-goals, approval, and rollback
intent.

```bash
sed -n '1,240p' section-3/starter/change-brief.md
```

[ sample output ]

```text
# Change brief: asynchronous workload jobs

## Outcome
```

The starter covers API and worker behaviour. It needs stronger design evidence
for state isolation, sensitive-data handling, architecture paths, and security
review.

### Read the environment and state map

This artifact decides what belongs to each lifecycle. Inspect it carefully.

```bash
sed -n '1,260p' section-3/starter/environment-state-map.md
```

[ sample output ]

```text
# Environment and state ownership

## Environment map
```

Look for two unsafe decisions:

1. test and production claim the same Terraform state;
2. application job data is planned inside Terraform state.

These are intentional faults in the starter.

### Read the ADR

The ADR records why ownership is divided by lifecycle and what rollback must
protect.

```bash
sed -n '1,260p' section-3/starter/decisions/0001-queue-ownership.md
```

[ sample output ]

```text
# ADR 0001: Own the asynchronous queue by lifecycle

## Status
```

Observe which decisions are already present. The candidate still needs explicit
environment isolation, secret rotation, runtime lookup, and security review.

### Read the architecture model

The CALM document gives reviewers a machine-readable view of components,
relationships, and trust boundaries.

```bash
sed -n '1,300p' section-3/starter/architecture/queue-feature.calm.json
```

[ sample output ]

```text
{
  "$schema": "https://calm.finos.org/release/1.2/meta/calm.json",
```

Trace the current relationships. The model has an API, queue, worker, result
store, and secret manager, but it does not yet show every path required by the
task. It already defines an HTTPS jobs interface, AMQP queue interfaces, and
separate security and operability controls. Preserve them.

Read the `controls-evidence-boundary` text before editing. A control in an
architecture document is a requirement for later implementation and testing.
It is not proof that encryption, authentication, monitoring, or recovery works
at runtime.

## PART III - See Why Two Validators Are Needed

### Run the local design check

The local checker knows the ownership rules for this course. Run it against the
unchanged starter.

```bash
node section-3/scripts/check-design-pack.mjs section-3/starter
```

[ Expected output ]

```text
Design pack: NEEDS WORK (2 design problems found)
- environment-state-map.md [terraform-state.contents]: Application job data belongs to the application, not Terraform state.
- environment-state-map.md [environments.test.state]: Test and production must use different Terraform state.
```

The command exits with status 1. This is the expected starting point.

### Check the starter against CALM

Now validate the architecture syntax with the official CALM CLI.

```bash
npx --yes @finos/calm-cli@1.57.0 validate -a section-3/starter/architecture/queue-feature.calm.json -f pretty
```

[ Expected output ]

```text
info [calm-validate]:     Formatting output as pretty
Summary
- Errors: no (0)
- Warnings: no (0)
- Info/Hints: 0

No issues found.
```

The unsafe starter can pass CALM because it is valid against the CALM 1.2
schema. Schema conformance does not decide whether Terraform owns the correct
data or whether two environments share state. The local checker and CALM answer
different questions.

If npm cannot download the package, record:

```text
CALM schema validation: NOT RUN - package download unavailable
```

Continue with the local design work. Do not record CALM as passed when the CLI
did not run.

## PART IV - Complete the Design Pack

### Choose how you will edit

The instructor demonstration uses Codex. From the repository root, start its
interactive session with:

```bash
codex
```

[ sample output ]

```text
Codex opens an interactive session in the current repository.
```

Then give it this instruction:

```text
Read section-3/request.md and section-3/task.md. Explain the unsafe decisions
before editing. Change only the four allowed design artifacts. Stop after local
and CALM validation. Keep every human approval pending.
```

You may use Claude Code, Goose, Cursor, Copilot, another compatible coding
agent, or edit manually. The task contract and validators are the same for every
path.

### Correct environment and data ownership

Open `section-3/starter/environment-state-map.md` in your editor.

Make these engineering decisions visible:

- local, test, and production have different state paths and queue boundaries;
- Terraform state stores resource identifiers and non-secret infrastructure
  configuration only;
- job payloads, status, and results belong to application runtime storage;
- secret management owns credential and encryption-key values;
- the API and worker resolve secret values at runtime;
- Terraform, Helm, GitOps, application configuration, and secret management
  have separate lifecycle responsibilities.

Do not move a problem from one table to another. The finished document should
state both the owner and the storage boundary for runtime data.

### Strengthen the change brief

Open `section-3/starter/change-brief.md`.

Add observable criteria for:

- separate state and queue resources in every environment;
- absence of job data and secret values from Terraform state and Git;
- the client, queue, result, and trust-boundary paths in the architecture model.

Record any assumption about the result store. Keep implementation and product
selection outside the scope. Add security to the required review and state that
the candidate is not approved.

### Complete the ADR

Open `section-3/starter/decisions/0001-queue-ownership.md`.

Record why each environment needs independent state, where secret values live,
how workloads obtain them, and who reviews the boundary. Add the operational
consequence that a state operation in one environment must not claim another
environment's queue.

Keep rollback safe for accepted jobs. Removing a queue is not the first rollback
action.

### Complete the CALM relationships

Open `section-3/starter/architecture/queue-feature.calm.json`.

Add the missing actor and relationships so a reviewer can trace:

1. client to API;
2. API to queue;
3. queue to worker;
4. worker to result store;
5. API to result store;
6. API and worker runtime access to secret management.

Give the external client its own trust boundary. Keep node IDs and relationship
references consistent. Preserve the HTTPS API interface, AMQP queue interfaces,
and the separate TLS and operability control requirements. This file is an architecture model, not
deployment configuration or runtime evidence.

## PART V - Validate and Review the Candidate

### Run the local design check again

Run the same course validator after all four artifacts are complete.

```bash
node section-3/scripts/check-design-pack.mjs section-3/starter
```

[ Expected output ]

```text
Design pack: PASS (0 design problems found)
The local ownership and safety rules are satisfied.
```

This proves the rules encoded by the local validator. It does not prove that
the design is approved or that an implementation will work.

### Validate the completed CALM model

Run the schema check against the edited architecture file.

```bash
npx --yes @finos/calm-cli@1.57.0 validate -a section-3/starter/architecture/queue-feature.calm.json -f pretty
```

[ Expected output ]

```text
info [calm-validate]:     Formatting output as pretty
Summary
- Errors: no (0)
- Warnings: no (0)
- Info/Hints: 0

No issues found.
```

If the package is unavailable, keep the local PASS and record CALM as NOT RUN.
Do not replace missing schema evidence with an assumption.

### Confirm the changed scope

Check which starter files changed before review.

```bash
git status --short section-3/starter
```

[ Expected output ]

```text
 M section-3/starter/architecture/queue-feature.calm.json
 M section-3/starter/change-brief.md
 M section-3/starter/decisions/0001-queue-ownership.md
 M section-3/starter/environment-state-map.md
```

Four changed design artifacts are expected. Terraform, Helm, GitOps, or
application implementation files must not appear.

## Checkpoint

Your Section 3 checkpoint is a reviewable design pack with this evidence:

| Evidence | Required result |
| --- | --- |
| Local design validator | `PASS (0 design problems found)` |
| CALM validator | `No issues found`, or honestly recorded as `NOT RUN` |
| Changed scope | Only the four allowed design artifacts |
| Implementation | Not generated |
| Human approval | Pending |

Continue with the [settings ownership challenge](challenge/settings-to-place.md)
after you record this checkpoint.

## Troubleshooting

### The local check still reports two problems

Read the artifact and field named in each message. Give test and production
different state paths. Remove runtime job data from the planned Terraform state
contents and record its application-owned storage boundary.

### The local check passes before you complete the design

The checker covers a small set of course rules. Use every acceptance criterion
in `task.md`; do not stop at the first green command.

### CALM reports an unknown node reference

Compare each relationship source and destination with the node `unique-id`
values. The spelling must match exactly.

### npm cannot reach the registry

Keep the local validator result. Record CALM as NOT RUN and retry when npm
network access is available. A network failure does not require cloud
credentials or a global package install.

## Teardown

This lab creates no infrastructure and runs no background service. No runtime
teardown is required. Keep the four changed artifacts for human design review.

## Summary

You converted a feature request into a bounded design pack, separated lifecycle
ownership, checked a CALM architecture model, and stopped before implementation.
Automated evidence is ready; human approval is still pending.

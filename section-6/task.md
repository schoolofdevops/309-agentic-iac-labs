# Task contract: evaluate and repair one IaC workflow

## Goal

Turn the weak queue-review run into a repeatable workflow that passes four
independent gates: functional, safety, regression, and budget.

## Inspect first

- `request.md`
- `fixture/main.tf`
- `fixture/expected-summary.txt`
- `starter/workflow/plan.json`
- `starter/evals/suite.json`
- `starter/run-card.json`

## Allowed learner edits

- `starter/workflow/plan.json`
- `starter/evals/suite.json`
- `starter/run-card.json`

The harness, fixture, context files, tests, and incoming evidence are read-only
for this exercise.

## Required result

1. Select only the context needed for this task.
2. Remove the operation that writes outside `main.tf`.
3. Run the validation sequence once with no retry.
4. Enable functional, safety, regression, and budget gates.
5. Keep the fixed course price card labelled as an estimate.
6. Record the approval boundary and recovery action in the Run Card.

## Required checks

Run the commands printed in `README.md`. The final evaluator must report zero
problems with either Terraform or OpenTofu.

## Forbidden actions

- Do not edit the fixture, harness, tests, context sources, or price card.
- Do not run plan, apply, destroy, state, import, or cloud-changing commands.
- Do not use credentials, provider downloads, model APIs, or network access.
- Do not execute arbitrary shell text.
- Do not weaken a threshold to make an unsafe run pass.
- Do not claim that an estimate is provider billing or that an evaluation is
  human approval.

## Stop conditions

Stop if a required CLI is missing, an immutable input changes, a path escapes
the isolated workspace, a command outside the fixed contract is requested, or
the evidence would contain an environment value.

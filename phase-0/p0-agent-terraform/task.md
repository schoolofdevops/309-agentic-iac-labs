# P0 Governed Repair Task

## Objective

Repair the Terraform configuration so `terraform fmt -check` and `terraform validate` pass.

## Allowed scope

- `fixtures/broken-module/main.tf`
- `evidence/records/`

## Required evidence

1. Describe the defect before editing.
2. State the affected file and the intended smallest repair.
3. Run formatting and validation.
4. Record the task, artifact, and evaluation using `evidence/schema.json`.
5. Stop after validation. Do not run `terraform apply`.

## Stop conditions

- A command asks for cloud credentials or proposes an apply.
- The required repair extends beyond the allowed scope.
- Validation still fails after the agreed repair.

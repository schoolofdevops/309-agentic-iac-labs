# Safe Task Brief: Repair the Missing Terraform Provider

Use this task brief in Section 2 with Codex or another compatible coding agent.

## Objective

Repair the deliberately broken Terraform module. Keep the generated platform identifier and make both Terraform and OpenTofu validation pass.

## Allowed file

- `phase-0/p0-agent-terraform/fixtures/broken-module/main.tf`

## Allowed actions

- Read the repository instructions and the broken module.
- Explain the defect before editing.
- Edit the allowed `main.tf` file.
- Run `terraform fmt -check`.
- Initialize without a backend when a provider must be installed.
- Run Terraform and OpenTofu validation.
- Review the Git diff.

## Do not

- Run `terraform apply` or `tofu apply`.
- Run state commands.
- Delete or destroy infrastructure.
- Request cloud credentials.
- Edit files outside the allowed scope.

## Required evidence

- A short defect explanation.
- The final Git diff.
- Terraform formatting and validation output.
- OpenTofu validation output.
- A changed-file check confirming that only the allowed file changed.

## Stop and ask for help when

- The repair requires another file.
- A command requests cloud credentials.
- The same failure repeats after one repair attempt.
- Validation needs an apply, state operation, deletion, or another destructive action.

## Human approval

A human must separately approve any later apply, state change, deletion, or deployment. This task stops after validation.

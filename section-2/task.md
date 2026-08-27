# Section 2 Repair Task

## Goal

The starter keeps its generated platform identifier, but the Terraform resource
that creates it is missing. Restore that declaration so local Terraform and
OpenTofu validation succeed. Keep `output.platform_name` backed by
`random_id.platform.hex`. Declare `random_id.platform` with `byte_length = 4`;
this four-byte size is part of the required result, not a value for the agent to
guess.

## Work boundary

Edit only `section-2/starter/main.tf`. Explain the defect and the smallest
repair before you edit.

## Validate the repair

From `section-2/starter`, run these local validation commands:

```bash
terraform fmt -check
terraform init -backend=false -input=false
terraform validate -no-color
tofu fmt -check
tofu init -backend=false -input=false
tofu validate -no-color
```

Capture the validation output and the final diff for your review. Stop after
validation.

## About the provider lock file

This disposable dual-tool repair fixture intentionally ignores
`.terraform.lock.hcl`: Terraform and OpenTofu may rewrite provider source metadata
differently. Record any warning. You must not claim that a shared lock file
proves compatibility. Real deployable modules normally commit their lock file;
provider-lock workflows are taught later.

## Do not

- Run `terraform apply` or `tofu apply`.
- Run `terraform state` or `tofu state` commands.
- Request or use cloud credentials.
- Delete or destroy anything.
- Edit outside `section-2/starter/main.tf`.

Ask for help if the repair needs another file, a command asks for cloud
credentials, or local validation still fails after the repair.

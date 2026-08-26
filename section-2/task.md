# Section 2 Repair Task

## Goal

The starter keeps its generated platform identifier, but the Terraform resource
that creates it is missing. Restore that declaration so local Terraform and
OpenTofu validation succeed. Keep `output.platform_name` backed by
`random_id.platform.hex`.

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

## Do not

- Run `terraform apply` or `tofu apply`.
- Run `terraform state` or `tofu state` commands.
- Request or use cloud credentials.
- Delete or destroy anything.
- Edit outside `section-2/starter/main.tf`.

Ask for help if the repair needs another file, a command asks for cloud
credentials, or local validation still fails after the repair.

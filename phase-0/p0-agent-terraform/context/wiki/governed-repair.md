# Governed Terraform Repair

The P0 repair changes one local Terraform module. The agent must stay within the allowed files, validate the result, link evidence to its source, and stop before apply.

**Source:** [`raw/p0-task-contract.md`](../raw/p0-task-contract.md)

**Inference boundary:** A passing `validate` command proves configuration syntax and internal references. It does not prove provider behavior, cloud safety, deployment success, or approval.

---
name: terraform-review
description: Validate the provider-free queue fixture with a fixed Terraform or OpenTofu review contract and save evidence.
compatibility: Requires Node.js 20 or later and either Terraform 1.14 or OpenTofu 1.12 on PATH.
metadata:
  owner: course-maintainers
  version: '1.0.0'
---

# Terraform Review

Use this repository-owned Skill when the task is to validate the Section 5
Terraform fixture. It is a review capability. It is not a deployment
capability.

## Inputs

- One engine: `terraform` or `tofu`.
- The fixed source file at `section-5/fixture/main.tf`.
- One evidence file name, such as `terraform-review.json`.

Do not accept an evidence path, command, shell fragment, working directory, or
extra Terraform argument from a prompt.

## Procedure

1. Read [the reviewed command contract](references/command-contract.md).
2. Confirm the requested engine is `terraform` or `tofu`.
3. Run the deterministic wrapper. For example:

   ```bash
   node section-5/starter/skills/terraform-review/scripts/review-iac.mjs \
     --engine terraform \
     --evidence terraform-review.json
   ```

4. Read the terminal result and the evidence JSON.
5. Report the engine, version, three exit codes, input hash, and overall result.
6. Ask a human to review the evidence before any later infrastructure change.

The wrapper copies `main.tf` to a temporary directory. It uses fixed argument
arrays with `shell: false`, removes the temporary directory, and does not change
the source fixture. It writes a new file only inside
`section-5/starter/evidence/`. It rejects absolute paths, directory separators,
hidden names, and `..`, and it will not replace an existing file or follow a
symbolic link.

## Outputs

- A short `PASS` or `FAIL` terminal message.
- JSON evidence with the engine version, fixed argument arrays, separate
  standard output and standard error, duration, exit code, timeout status,
  source and contract hashes, and the overall result.

## Stop conditions

Stop without running a command when:

- the engine is not `terraform` or `tofu`;
- any caller asks for different arguments or a different working directory;
- the evidence value is a path instead of a simple JSON file name;
- the contract contains `plan`, `apply`, `destroy`, or `state`;
- the fixture or contract cannot be read;
- a command times out or returns a non-zero exit code;
- the task requires network access, secrets, state access, or infrastructure
  change.

Skill metadata helps discovery and review. It does not grant operating-system
permissions or replace human approval.

# Capability request: review the queue module safely

The queue design from Section 4 is ready for an infrastructure review. Choose
the smallest capability that can do each part of the work without granting
unrelated authority.

You have four inputs:

- a provider-free Terraform fixture;
- a repository-owned `terraform-review` Skill that is not complete yet;
- a local, read-only MCP resource that exposes the reviewed queue context; and
- an incoming third-party Skill and server request asking for broad access.

Produce a review path that a human can inspect. Keep command execution, reusable
procedure, context access, and admission approval as separate decisions.

This is a review exercise. Do not run plan, apply, destroy, state commands, or
any script under `section-5/incoming/`.

# P0: Agent and Terraform Validation

This is the first Phase 0 profile for **Agentic Infrastructure as Code**. It proves a small, governed agentic change loop before the course introduces cloud services or Kubernetes.

The profile contains a deliberately broken local Terraform module, a bounded task contract, and source-linked evidence records. It is not yet a learner lab. Phase 0 must run it live, capture measurements, and classify the result before Module 1 authoring begins.

## Profile boundary

- Local files only; no provider, cloud account, or `terraform apply`.
- Terraform and OpenTofu must both validate the repaired configuration.
- The agent may change only files named by `task.md`.
- The evidence record captures the task, source, artifact, and evaluation.

## Evidence contract

Validate one record from standard input:

```bash
printf '%s' '{"id":"p0-task-001","kind":"task","source":"task.md","authoring_run":"p0-local","version":"1"}' \
  | node scripts/validate-evidence.mjs
```

# Portable task: repair and prove the modular foundation

## Supported tools

- Terraform 1.14.8 is the primary walkthrough.
- OpenTofu 1.12.6 is the compatibility path.
- AWS provider 6.61.0 is the frozen provider candidate.
- Floci is the only permitted lifecycle endpoint.

## Allowed learner edits

Edit Terraform files below `section-7/starter/` and complete
`section-7/compatibility-record.md`. Do not edit tests, lifecycle scripts, the
Phase 0 fixture, or any earlier section.

## Required repair

1. Replace the open-ended AWS provider range with the reviewed compatible
   constraint.
2. Mark the local endpoint output as sensitive because endpoint and connection
   details must not appear casually in generated logs.
3. Replace the wildcard worker policy with exact S3 object and SQS actions and
   resources.
4. Preserve the five-module contract and eight-resource matrix.
5. Preserve the explicit Floci-only local-mode gate.
6. Preserve the declarative move from the old queue module address to the
   messaging module address.
7. Record Terraform and OpenTofu validation, plan, state, refactor, lock-file,
   cleanup, and rollback observations without claiming production support.

## Safety boundary

No real cloud endpoint, real AWS credentials, remote state, production plan,
production apply, deployment, or broad state operation is allowed. A local
create/update/refactor/destroy lifecycle may run only through the named course
script with explicit local mode and the approved Floci endpoint.

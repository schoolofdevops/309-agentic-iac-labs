# Operator Challenge: Review Four Terraform Plan Signals

Your platform team proposes the following plan for a shared environment. The
plan is a review exercise only. Do not apply it.

| Address | Plan signal | Important detail |
|---|---|---|
| `module.messaging.aws_sqs_queue.jobs` | `~ update in-place` | Visibility timeout changes from 30 to 45 seconds. |
| `module.storage.aws_s3_bucket.artifacts` | `-/+ replace` | A generated name change forces replacement; the bucket may contain artifacts. |
| `module.identity.aws_iam_role_policy.worker_data_access` | `~ update in-place` | One policy resource is `(known after apply)` because its input comes from a replacing bucket. |
| `module.queue.aws_sqs_queue.jobs` | moved to `module.messaging.aws_sqs_queue.jobs` | A reviewed `moved` block maps the same remote queue identity. |

The generated agent summary says, “Four safe updates. Ready to apply.”

## Your task

Write a review verdict that answers:

1. Which action may proceed after ordinary evidence review?
2. Which action must stop for redesign or migration planning?
3. What does the unknown value prevent you from approving?
4. What evidence proves that the moved address does not recreate the queue?
5. Which state, backup, data, and rollback facts must be recorded?
6. What claim is wrong in the agent summary?
7. What is the exact next human decision?

Separate plan facts, runtime unknowns, state identity, data risk, and approval.
Do not use a green validation result as evidence that replacement is safe.

When your verdict is complete, compare it with the separate
[answer key](answer-key.md).

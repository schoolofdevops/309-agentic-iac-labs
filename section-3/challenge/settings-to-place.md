# Operator Challenge: Place Each Setting by Lifecycle

The queue feature crosses several tools, but each setting needs one primary
lifecycle owner. Place every setting under exactly one of these categories:

- Terraform
- Helm
- GitOps
- Application configuration
- Secret management

## Your task

Copy the table into your notes. For each setting, add:

1. one primary owner from the five categories;
2. a short reason based on who creates, changes, reviews, or rotates it;
3. what event starts its change lifecycle;
4. one piece of review or validation evidence.

Do not place a setting by matching words in its name. Ask who owns its lifecycle
and whether the item is a resource, deploy-time input, promotion record, runtime
behaviour, or secret value.

| # | Setting to place |
| --- | --- |
| 1 | Create the queue and its dead-letter queue for each environment. |
| 2 | Set the queue message-retention period as part of the provisioned resource. |
| 3 | Create the access-policy resources that permit the API and worker to use the queue. |
| 4 | Set the worker replica count supplied to the deployed workload. |
| 5 | Supply the non-secret queue endpoint reference to the API and worker pods. |
| 6 | Promote an approved application chart and image revision from test to production. |
| 7 | Promote the reviewed production values revision after the test evidence passes. |
| 8 | Limit how many times application code retries a failed job. |
| 9 | Define the allowed job-status transitions such as `queued` to `running`. |
| 10 | Define the application idempotency behaviour for a repeated submission key. |
| 11 | Store and rotate the queue credential value used at runtime. |
| 12 | Store and rotate the encryption-key value used to protect queued data. |

## Review questions

- Which settings change when infrastructure is replaced?
- Which settings change when a workload is deployed?
- Which settings move between environments only after review?
- Which settings belong to runtime application behaviour?
- Which values must never appear in Terraform state or Git?
- Can a non-secret secret reference cross a repository boundary without moving
  the secret value itself?

## Completion check

Your table is complete when all twelve settings have one primary owner, a
lifecycle reason, a trigger, and evidence. Keep human approval pending. This
challenge produces no code and runs no apply or deployment command.

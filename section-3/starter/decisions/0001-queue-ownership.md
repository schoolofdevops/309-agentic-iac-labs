# ADR 0001: Own the asynchronous queue by lifecycle

## Status

Proposed for platform and application review.

## Context

The workload API needs an asynchronous path. Infrastructure resources, workload settings, promotion records, runtime job data, and secret values change at different times and have different reviewers.

## Decision

Terraform owns the queue and access-policy resources. Helm supplies deploy-time references to the API and worker. GitOps promotes reviewed desired state. The application owns job payloads, status, results, retry behavior, and recovery behavior. Secret management owns reusable secret values.

## Alternatives considered

1. Put queue resources, job data, and credentials in Terraform state. Rejected because runtime data and reusable secrets do not belong in an infrastructure lifecycle record.
2. Let the application create and delete the queue. Rejected because the infrastructure would not have a reviewed, repeatable lifecycle.
3. Keep the synchronous route only. Rejected because long jobs hold client connections open.

## Consequences

- Reviewers can see one lifecycle owner for each setting and data type.
- The API and worker need a stable queue reference and a runtime secret lookup.
- Operations need queue-depth, retry, and failed-job evidence before production approval.

## Rollback intent

Stop new asynchronous submissions, drain or recover accepted jobs, restore the synchronous route, and retain the queue until a human confirms that no job data remains.

## Approval

Pending platform engineering and application engineering approval.

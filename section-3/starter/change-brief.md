# Change brief: asynchronous workload jobs

## Outcome

Clients can submit a workload without keeping the HTTP connection open. The platform returns a job ID, processes the job in a worker, and exposes status and result data through the API.

## Acceptance criteria

1. Given a valid request, the API returns HTTP 202 and a non-empty job ID within 500 milliseconds in the local test.
2. Given the returned job ID, the status endpoint reports `queued`, `running`, `succeeded`, or `failed`.
3. When a worker succeeds, the result endpoint returns the result associated with that job ID.
4. When processing fails, the worker retries no more than three times and exposes the final failure state.
5. Local, test, and production use separate Terraform state and separate queue resources.

## Assumptions

- The existing API already authenticates clients.
- The worker uses the same application release as the API.
- A managed queue can be represented by a local substitute during development.

## Non-goals

- Choosing a cloud queue product
- Implementing Terraform, Helm, GitOps, or application code in this section
- Designing a multi-region disaster-recovery topology

## Change class

**Class:** Stateful platform change

The change introduces a queue, a worker, and new runtime data. It requires a platform reviewer and an application reviewer before implementation.

## Approval

**Status:** Ready for design review

Required reviewers: platform engineering and application engineering.

## Rollback intent

Disable new job submissions, allow accepted jobs to finish or move them to a recovery queue, and restore the synchronous API route. Infrastructure removal happens only after the queue is empty and a human approves it.

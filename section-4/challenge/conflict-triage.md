# Challenge: Resolve a Three-Way Context Conflict

An IaC coding agent is preparing the asynchronous queue change. Three records
make different claims about the design:

| Source | Trust and freshness | Claim |
| --- | --- | --- |
| `SRC-POLICY-2026-08` | Direct current policy | Test and production must use separate Terraform state and resource boundaries. |
| `SRC-ADR-0002` | Superseded architecture record | Test and production may share Terraform state. |
| `OBS-VALIDATION-2026-08-26` | Direct current validation observation | The current design passed the ownership validator and CALM schema validation. |

## Your Task

Write a short conflict record for a reviewer. Include all four parts:

1. **Winning source** — name the source that controls the state decision and
   explain why.
2. **Rejected claim** — quote or paraphrase the claim that must not enter the
   implementation context.
3. **Correction path** — explain how the wiki, evidence graph, retrieval pack,
   and append-only log should record the correction.
4. **Evidence limit** — state exactly what the current validation observation
   proves and what it does not prove.

Do not solve the conflict by deleting the ADR. Keep it as superseded history so
a future reviewer can see why the decision changed.

## Review Questions

- Does a newer timestamp always make a source more authoritative?
- Can a current validation result override current policy?
- Does a passing schema check prove separate state at runtime?
- Which graph relationship records the rejected claim without treating it as
  current direction?
- What human decision is still required before implementation begins?

## Acceptance Criteria

Your conflict record is complete when it:

- selects one winning source and gives an authority reason;
- rejects the shared-state claim without deleting its history;
- names a correction in all four compiled artifacts;
- distinguishes design validation from implementation and runtime proof;
- keeps human approval pending;
- creates no infrastructure code and runs no apply or deployment command.

## Checkpoint

Give your record to another learner or reviewer. Ask them to identify one place
where your reasoning depends on authority and one place where it depends on
freshness.

The answer key remains outside the default learner path. Defend your source
decision before comparing it with the reference reasoning.

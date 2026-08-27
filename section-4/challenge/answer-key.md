# Answer Key: Resolve a Three-Way Context Conflict

Use this reference after completing your own conflict record.

## 1. Winning Source

`SRC-POLICY-2026-08` wins the state decision. It is the direct current policy,
and it explicitly requires separate Terraform state and resource boundaries for
local, test, and production.

The validation observation is newer than the policy, but it is evidence about a
specific design candidate. It has no authority to change policy. Source type
and scope matter as much as timestamp.

## 2. Rejected Claim

Reject this claim from `SRC-ADR-0002`:

> Test and production may share one Terraform state.

The ADR labels itself superseded, and its supersession note points to current
policy. Incident 042 supplies direct historical evidence for why the earlier
decision was unsafe.

## 3. Correction Path

- **Wiki:** Mark shared Terraform state as rejected. Link the decision to current
  policy and Incident 042. Preserve ADR 0002 as superseded architecture memory.
- **Evidence graph:** Keep the ADR-to-claim relationship with `superseded`
  status. Add current policy and incident relationships that contradict the
  shared-state claim. Include source references, timestamps, authoring runs, and
  review status.
- **Retrieval pack:** Select current policy. Include the ADR only as rejected
  historical context. Select the current validation observation for its bounded
  evidence. Do not present the ADR claim as current direction.
- **Maintenance log:** Append a `CORRECTION` event. Do not rewrite the earlier
  ingest and compile records.

## 4. Evidence Limit

`OBS-VALIDATION-2026-08-26` proves that the local ownership check and FINOS CALM
schema validation passed for the exact Section 3 design candidate. It does not
prove that:

- infrastructure was implemented;
- state is separated in a deployed environment;
- runtime controls work;
- every relevant source was retrieved;
- a human approved implementation or deployment.

## Final Review

The correct result preserves all three records for different purposes: policy
controls the decision, the ADR explains rejected history, and validation records
bounded evidence about the current design. Human approval remains pending.

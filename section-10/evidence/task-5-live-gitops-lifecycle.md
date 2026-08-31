# Section 10 Task 5 — live GitOps lifecycle

**Status:** PASS — 31 August 2026

This is one fresh local lifecycle on the reference arm64 authoring machine.
It used the runner at labs revision `2cd7abdd7b7e639345ddc1154d2f924e4a813ade`, a disposable three-commit delivery repository, and macOS sleep prevention. It is not a cloud deployment or proof of an external identity provider.

## Delivery and approval sequence

| Step | Revision | Result |
| --- | --- | --- |
| v1 launch | `2cd7abdd7b7e639345ddc1154d2f924e4a813ade` | `s10-v1` synced and Healthy |
| v2 promotion | `473b4eaa92c9608747f6d1923b89840df54ff9d1` | separate helper invoked the learner approval CLI; `s10-v2` synced |
| drift check | — | API scaled to two replicas and remained at two after 15 seconds |
| recovery | `c8cb7cc4e9015302c2d77e9aff65fe0ddd522e2a` | separate helper invoked the learner approval CLI; `s10-v1` recovered |

The v2 and recovery gates were opened by the lifecycle runner. The separate helper process used:

```text
node section-10/scripts/approve-gitops-revision.mjs --gate <runner-gate> --output <derived-approval> --revision <exact-revision> --purpose <frozen-purpose>
```

Observed helper output:

```text
Approved revision 473b4eaa92c9608747f6d1923b89840df54ff9d1 for promote-v2.
Approved revision c8cb7cc4e9015302c2d77e9aff65fe0ddd522e2a for revert-and-recover.
```

## Runtime command and result

The lifecycle ran under `caffeinate -dimsu` with the explicit delivery root,
mirror root, three full revisions, and three approval paths. It returned:

```json
{
  "result": "PASS",
  "elapsed_ms": 171073,
  "peak_bytes": 1641751249,
  "peak_gib": 1.529,
  "request_status": "complete",
  "v1_image": "309-agentic-iac/inference-platform:s10-v1",
  "v2_image": "309-agentic-iac/inference-platform:s10-v2",
  "recovery_image": "309-agentic-iac/inference-platform:s10-v1",
  "drift_replicas_after_15_seconds": 2
}
```

The named Kind control-plane peak was 1.529 GiB, below the 4 GiB core-lab workload gate.

## Cleanup proof

The runner reported `cleanup.status: PASS`, with no cleanup errors. It proved
the Application, Helm release, both namespaces, named cluster/node, and Git
mirror absent; both runner-owned late approval gates were absent. Direct final
checks returned `No kind clusters found.` and no Section 10 Docker container.

## Proof boundary

This records the exact local runner, revisions, explicit human-signed course
records, observed images, named-node memory sample, request completion, drift
behaviour, recovery, and cleanup for this run. It does not establish external
reviewer authentication, host-wide Docker memory use, or production Git
authorization.

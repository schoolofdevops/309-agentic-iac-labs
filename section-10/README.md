# Review an Agentic IaC Delivery Change

This static lab gives you one pull request candidate that crosses three delivery
lanes: a privileged workflow, Terraform intent, and an Argo CD Application.
The infrastructure and workload are valid. The delivery decision is not.

Start with [the request](request.md), then follow [the task contract](task.md).
The candidate is inert: its workflow lives below `starter/`, not in a
repository-root `.github/workflows` directory. The evaluator never applies,
deploys, syncs, or changes a cluster.

Run the independent check from the repository root. Give it a new evidence
directory below your operating-system temporary directory:

```console
node section-10/starter/protected/check-candidate.mjs \
  section-10/starter \
  "${TMPDIR:-/tmp}/agentic-iac-s10-candidate"
```

Read `report.json` in that directory. A rejected candidate should name the
three delivery problems in plain language while Terraform/OpenTofu and Helm
remain structurally valid.

The launcher, policy, manifest, tests, cleanup code, and evidence schema are
reviewer-owned. Their hashes stop an accidental learner edit from weakening the
local check. Git review and a separate human reviewer remain the real trust
boundary; this local mechanism is not cryptographic self-attestation.

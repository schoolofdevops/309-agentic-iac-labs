# Review an Agentic IaC Delivery Change

This static lab gives you one pull request candidate that crosses three delivery
lanes: a privileged workflow, Terraform intent, and an Argo CD Application.
The infrastructure and workload are valid. The delivery decision is not.

Start with [the request](request.md), then follow [the task contract](task.md).
The candidate is inert: its workflow lives below `starter/`, not in a
repository-root `.github/workflows` directory. The evaluator never applies,
deploys, syncs, or changes a cluster.

Run the evaluator from a separate checkout of the human-approved base commit.
The starter branch is data only. Give the evaluator the approved base SHA, the
candidate SHA, and a new evidence directory below your operating-system
temporary directory:

```console
node <trusted-checkout>/section-10/scripts/run-starter-review.mjs \
  --source "$PWD" \
  --trusted-revision <approved-base-sha> \
  --candidate-revision <candidate-sha> \
  --output "${TMPDIR:-/tmp}/agentic-iac-s10-candidate"
```

Read `report.json` in that directory. A rejected candidate should name the
three delivery problems in plain language while Terraform/OpenTofu and Helm
remain structurally valid.

The launcher, contract, policies, cleanup code, and evidence schema come from
the approved Git base. Candidate replacements are never executed. The runner
materializes candidate data from the named Git commit, rejects unapproved HCL
before an engine starts, and binds the result to both revisions. The approved
base and separate human review are the trust boundary.

# Review an Agentic IaC Delivery Change

This static lab gives you one pull request candidate that crosses three delivery
lanes: a privileged workflow, Terraform intent, and an Argo CD Application.
The infrastructure and workload are valid. The delivery decision is not.

Start with [the request](request.md), then follow [the task contract](task.md).
The candidate is inert: its workflow lives below `starter/`, not in a
repository-root `.github/workflows` directory. The evaluator never applies,
deploys, syncs, or changes a cluster.

## Load local images into the course Kind node

Kind 0.27 can create the pinned course node but cannot load images through its
built-in helper when that node uses containerd configuration version 4. Use
the same course command with Kind 0.27 or Kind 0.32:

```console
node section-10/scripts/load-kind-images.mjs \
  --cluster agentic-iac-s10 \
  <local-image> [<local-image> ...]
```

The helper checks that `agentic-iac-s10-control-plane` belongs to the named
Kind cluster and that every image exists locally before transfer. It streams
each Docker image archive into the disposable node's containerd image store
and stops with the image name when a transfer fails. The transfer uses
privileged containerd access only inside that local node. It does not change
the workload security context.

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

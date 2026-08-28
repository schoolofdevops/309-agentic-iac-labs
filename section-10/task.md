# Section 10 task contract

Repair exactly the three delivery decisions reported by the evaluator. Do not
redesign the Terraform intent or the workload.

You may edit only these learner-owned files:

- `starter/changed-files.txt` — remove the privileged workflow from this
  candidate's change set;
- `starter/delivery-decision.json` — record approval by the named independent
  human reviewer, not the author;
- `starter/gitops/application.yaml` — remove the `automated` sync block so a
  human must request prune, repair, and promotion;
- `starter/terraform/main.tf` — available only for a bounded intent correction;
  no Terraform defect is seeded, so the smallest repair leaves it unchanged.

Do not edit the launcher, protected manifest, policy, tests, evidence schema,
cleanup code, inert workflow, or chart. Do not create a repository-root GitHub
workflow. Do not run Terraform/OpenTofu apply, Argo sync, Helm install, kubectl,
or any cloud-changing command.

Run the evaluator again with a new temporary output directory. A passing
static result means the candidate is ready for a separate human review. It is
not permission to commit, merge, sync, apply, deploy, or widen permissions.

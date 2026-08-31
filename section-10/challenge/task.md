# Diagnose a stale GitOps recovery

You have created the recovery commit, but you have not published or synced it.
The live API still has the two-replica drift from the main lab. Automatic
self-heal is disabled.

Your task is to explain why the Application becomes `OutOfSync` and
`Degraded`, then choose the recovery action. Do not run Terraform or OpenTofu
apply. Do not edit either plan JSON file.

## Create the failure symptom

The API image below does not exist in the Kind node. Patch only the live API
Deployment. This creates a failed rollout while the existing pods remain
available.

```bash
S10_FAILURE_PATCH="$(jq -cn '{
  spec: {
    progressDeadlineSeconds: 5,
    template: {
      spec: {
        containers: [{
          name: "api",
          image: "309-agentic-iac/inference-platform:stale-missing",
          imagePullPolicy: "Never"
        }]
      }
    }
  }
}')"

echo "$S10_FAILURE_PATCH" | jq
kubectl --context kind-agentic-iac-s10 \
  -n "$S10_WORKLOAD_NAMESPACE" \
  patch deployment inference-platform-api \
  --type=strategic \
  --patch "$S10_FAILURE_PATCH"

sleep 10
kubectl --context kind-agentic-iac-s10 \
  -n argocd annotate application inference-platform \
  argocd.argoproj.io/refresh=hard --overwrite
sleep 3
```

[ sample output ]

```text
deployment.apps/inference-platform-api patched
application.argoproj.io/inference-platform annotated
```

The printed JSON patch appears before these two stable command-result lines.

## Collect Git evidence

Check the commit that exists in your delivery repository. Compare it with the
two commits below it.

```bash
git rev-parse HEAD
git log --oneline -3
```

[ sample output ]

```text
2a424872cbd2faab55626579e768ad55f94a6f67
2a42487 Revert "Promote inference platform to s10-v2"
bb10f6d Promote inference platform to s10-v2
b20b835 Repair Section 10 delivery boundaries
```

## Collect mirror evidence

The read-only mirror is the source Argo CD can reach. Check which revision its
container label exposes.

```bash
docker inspect agentic-iac-s10-git \
  --format 'source_revision={{index .Config.Labels "com.schoolofdevops.source-revision"}} rootfs_readonly={{.HostConfig.ReadonlyRootfs}} mount_rw={{(index .Mounts 0).RW}}'
```

[ sample output ]

```text
source_revision=bb10f6d49edee4c57a7dc4d54a3c381a8392bba5 rootfs_readonly=true mount_rw=false
```

## Collect Application evidence

The Deployment can report its failed rollout before Argo CD refreshes the
Application health projection. Wait for `Degraded`, then check the configured
target and the revision Argo CD actually resolved from that target.

```bash
kubectl --context kind-agentic-iac-s10 \
  -n argocd wait \
  --for=jsonpath='{.status.health.status}'=Degraded \
  application/inference-platform --timeout=60s

kubectl --context kind-agentic-iac-s10 \
  -n argocd get application inference-platform \
  -o custom-columns='TARGET:.spec.source.targetRevision,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision'
```

[ sample output ]

```text
application.argoproj.io/inference-platform condition met
TARGET   SYNC        HEALTH     REVISION
HEAD     OutOfSync   Degraded   bb10f6d49edee4c57a7dc4d54a3c381a8392bba5
```

## Collect controller and workload evidence

Events explain the failed image start. Deployment status shows the requested
replicas, ready replicas, image, and rollout condition.

```bash
kubectl --context kind-agentic-iac-s10 \
  -n "$S10_WORKLOAD_NAMESPACE" get events \
  --field-selector involvedObject.kind=Pod \
  --sort-by='.lastTimestamp'

kubectl --context kind-agentic-iac-s10 \
  -n "$S10_WORKLOAD_NAMESPACE" get deployment inference-platform-api \
  -o custom-columns='DESIRED:.spec.replicas,READY:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image,PROGRESS:.status.conditions[?(@.type=="Progressing")].reason'
```

[ sample output ]

```text
12s   Warning   Failed              pod/inference-platform-api-6b7c989fb6-dmfl8   Error: ErrImageNeverPull
12s   Warning   ErrImageNeverPull   pod/inference-platform-api-6b7c989fb6-dmfl8   Container image "309-agentic-iac/inference-platform:stale-missing" is not present with pull policy of Never
DESIRED   READY   IMAGE                                              PROGRESS
2         2       309-agentic-iac/inference-platform:stale-missing   ProgressDeadlineExceeded
```

## Compare plan evidence

The plan files came from direct Terraform and OpenTofu plan commands. Read the
resource actions and the delivery boundary.

```bash
jq -r '.resource_changes[] | [.address, (.change.actions | join(","))] | @tsv' \
  "$S10_PLAN_ROOT/terraform-plan.json" \
  "$S10_PLAN_ROOT/opentofu-plan.json"

jq '{reviewer:.identities.reviewer,apply_permitted}' \
  section-10/starter/delivery-decision.json
```

[ Expected output ]

```text
terraform_data.reviewed_delivery    create
terraform_data.reviewed_delivery    create
{
  "reviewer": "human-platform-reviewer",
  "apply_permitted": false
}
```

## Make the diagnosis

Answer these questions before you continue with recovery:

1. Which revision is in local Git, in the mirror, and in Application status?
2. Why did `targetRevision: HEAD` not select the local recovery commit?
3. Why are two old API pods still ready while the new rollout is degraded?
4. What does the plan evidence prove, and what does it not prove?
5. What exact human actions should recover the workload?

Do not repair the live Deployment by hand. Return to the main lab after you
write the diagnosis. The recovery path is to approve and publish the Git
revert, then request an explicit Argo CD sync.

# Answer Key: Advanced Live Diagnostics Lab

Use this key only after you have recorded the evidence requested in `task.md`.
A diagnosis without the evidence trail is incomplete.

The evidence comes from cluster `agentic-iac-s9`, context
`kind-agentic-iac-s9`, namespace inference, and release
`inference-platform`.

## Failure 1: `bad-readiness-path`

The new API Pod is `Running` but `0/1`. Its rollout times out, and the warning
event reports readiness HTTP 404. The Deployment description shows `/ready`,
while the Helm manifest still renders `/readyz`.

The ready API EndpointSlice can still contain the old Pod during the failed
rollout. Empty API logs do not clear the probe failure. These signals prove
live Deployment drift, not a Helm value change.

Restore only `/readyz`, wait for the API rollout, and prove one ready API Pod,
a ready endpoint, and `ready HTTP 200` before continuing.

## Failure 2: `unreachable-backend-connection`

The new worker Pod is `Running` but `0/1`, and its rollout times out. Events
report readiness HTTP 503. Logs from the new worker show that
`unreachable-backend` cannot be resolved.

The real dependency EndpointSlice remains ready. The Helm manifest still
renders the `inference-platform` ConfigMap reference. The live Deployment
instead contains the literal unreachable URL. These signals prove live worker
drift, not a failed dependency Service.

Restore the ConfigMap reference, wait for the worker rollout, and prove one
ready worker Pod while the dependency endpoint remains ready.

## Failure 3: `wrong-helm-value`

The API Pod, rollout, and EndpointSlice remain healthy. The Deployment still
uses `/readyz`, and API logs show no application failure. The broken signal is
the host request through port `18080`.

Helm values, the Helm manifest, and the live Service all show NodePort `30081`.
Kind still maps host port `18080` to NodePort `30080`. These signals prove that
the wrong port is Helm release intent, not live Deployment drift.

Reset Helm to the reviewed values. Prove the render contains `30080`, the API
remains ready, and `/readyz` returns HTTP 200 through `127.0.0.1:18080`.

```bash
helm upgrade inference-platform section-9/chart --kube-context kind-agentic-iac-s9 --namespace inference --reset-values --set networkPolicy.enabled=false --force-conflicts --wait --timeout 120s
```

[ sample output ]

```text
Release "inference-platform" has been upgraded. Happy Helming!
STATUS: deployed
```

Use `kubectl rollout status` for the API after Helm returns.

## Final result

Each failure was recovered before the next injection. The final release has
three ready Pods, the original ready endpoints, NodePort `30080`, and a working
host request. This is suitable for human review of the disposable local run.
It is not production approval.

NetworkPolicy remains disabled. The challenge proves probe, dependency, Helm
value, and reconciliation behaviour on `agentic-iac-s9`. It does not prove
NetworkPolicy enforcement.

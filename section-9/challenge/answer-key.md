# Answer Key: Diagnose Three Kubernetes and Helm Failures

Use this key only after you have recorded the evidence requested in
`task.md`. A diagnosis without the evidence trail is incomplete.

## Failure 1: `wrong-helm-value`

The API Pod and its endpoint can remain healthy, but the host curl to port
`18080` fails. The Kind configuration maps host port `18080` to node port
`30080`. `helm get values --all`, the Helm manifest, and `kubectl get service`
show the wrong Helm value `30081`.

This failure is Helm intent, not out-of-band drift. Reset the release to the
reviewed chart value `30080`. Then prove the Service exposes
`8080:30080/TCP`, the endpoint is ready, and curl reaches `/readyz` through
`127.0.0.1:18080`.

## Failure 2: `bad-readiness-path`

The API container is running, but the new Pod shows `0/1` in the READY column.
The Deployment description and events report a readiness-probe HTTP failure
for `/ready`. The application implements `/readyz`, not `/ready`.

The Helm manifest still renders `/readyz`. The live Deployment renders
`/ready` because the diagnostic patch changed Kubernetes state outside Helm.
This difference is configuration drift. The smallest repair is to reconcile
the reviewed chart with Helm. Prove recovery with `kubectl rollout status`,
`kubectl get pods`, and an HTTP 200 response from `/readyz`.

## Failure 3: `unreachable-backend-connection`

The worker's dependency-aware readiness fails because its live `BACKEND_URL`
names `unreachable-backend`, which has no Service or endpoint in namespace
`inference`. The worker Pod may be `Running` while READY remains `0/1`.

The worker logs show backend name-resolution or connection errors. `kubectl
get endpoints` still shows the real `inference-platform-dependencies`
endpoint. The Helm manifest also names that real Service, while the live
Deployment does not. Reconcile the reviewed chart, then prove the worker
rollout and logs return to the expected polling flow.

## Recovery result

Restore the API path and the worker's ConfigMap reference before asking Helm 4
to reconcile the release. The final exact Helm recovery is:

```bash
helm upgrade inference-platform section-9/chart --kube-context kind-agentic-iac-s9 --namespace inference --reset-values --set networkPolicy.enabled=false --force-conflicts --wait --timeout 120s
```

[ sample output ]

```text
Release "inference-platform" has been upgraded.
STATUS: deployed
```

Both `kubectl rollout status` commands must complete, all three Pods must show
`1/1 Running`, both Services must have endpoints, and `/readyz` must return
HTTP 200. The bounded curl retry allows the Service data path to observe the
restored NodePort. The release is again suitable for human review of this
disposable local run. It is not production approval.

NetworkPolicy remains disabled. The challenge proves probe, dependency, Helm
value, and reconciliation behaviour on the exact `agentic-iac-s9` cluster. It
does not prove NetworkPolicy enforcement.

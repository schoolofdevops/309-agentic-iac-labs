# Challenge: Diagnose Three Kubernetes and Helm Failures

Start this challenge only after the repaired Section 9 release is healthy. Keep
the exact cluster `agentic-iac-s9`, context `kind-agentic-iac-s9`, namespace
`inference`, and release `inference-platform`.

This challenge introduces exactly three planned failures. The commands do not
change the chart source. They change the installed release and two live
Deployments so you can compare Helm intent with Kubernetes state.

Do not open the answer key until you have collected every requested signal and
written your own diagnosis.

## Failure 1: `wrong-helm-value`

Record the wrong NodePort as Helm release intent. Port `18080` on the host is
mapped to NodePort `30080`, so `30081` breaks the host path while the API Pod
can remain healthy.

```bash
helm upgrade inference-platform section-9/chart --kube-context kind-agentic-iac-s9 --namespace inference --reuse-values --set service.api.nodePort=30081
```

[ sample output ]

```text
Release "inference-platform" has been upgraded.
STATUS: deployed
```

## Failure 2: `bad-readiness-path`

Change only the live API readiness path. The new ReplicaSet should run, but it
should not become ready.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-api --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/ready"}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-api patched
```

## Failure 3: `unreachable-backend-connection`

Point only the live worker Deployment at a Service name that does not exist.
This keeps the failure inside the disposable Kind cluster.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-worker --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/env/1","value":{"name":"BACKEND_URL","value":"http://unreachable-backend:8081"}}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-worker patched
```

## Collect evidence before diagnosis

First, check Pod status. Do not diagnose from `Running` alone. The READY column
shows whether the probes accept traffic.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-api-...                0/1     Running   0
inference-platform-worker-...             0/1     Running   0
```

Next, read ordered controller and probe events.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get events --sort-by=.metadata.creationTimestamp
```

[ sample output ]

```text
Warning   Unhealthy   pod/inference-platform-api-...      Readiness probe failed
Warning   Unhealthy   pod/inference-platform-worker-...   Readiness probe failed
```

Check whether each Service has ready endpoints.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpoints
```

[ sample output ]

```text
NAME                              ENDPOINTS
inference-platform-api            <none>
inference-platform-dependencies   10.244.0.7:8081
```

Read the live Service port because the Kind host mapping depends on it.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get services
```

[ sample output ]

```text
NAME                     TYPE       PORT(S)
inference-platform-api   NodePort   8080:30081/TCP
```

Describe the API and worker Deployments. Record the live probe path, live
`BACKEND_URL`, rollout condition, and recent events.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference describe deployment/inference-platform-api
```

[ sample output ]

```text
Readiness:  http-get http://:8080/ready
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference describe deployment/inference-platform-worker
```

[ sample output ]

```text
BACKEND_URL:  http://unreachable-backend:8081
```

Read both application logs. Keep DNS, connection, HTTP status, and retry text
in your evidence notes.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference logs deployment/inference-platform-api --tail=50
```

[ sample output ]

```text
(the API may emit no application log line for a failed kubelet probe)
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference logs --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=worker --all-containers --tail=10 --prefix
```

[ sample output ]

```text
worker poll failed: backend request failed: ... no such host
```

Read the values stored with the Helm release.

```bash
helm get values inference-platform --kube-context kind-agentic-iac-s9 --namespace inference --all
```

[ sample output ]

```yaml
service:
  api:
    nodePort: 30081
```

Read the rendered release manifest. Compare its probe path, backend URL, and
NodePort with the two live Deployments and Service.

```bash
helm get manifest inference-platform --kube-context kind-agentic-iac-s9 --namespace inference
```

[ sample output ]

```yaml
readinessProbe:
  httpGet:
    path: /readyz
```

Finally, observe the broken host path without hiding the curl error.

```bash
curl -sS -o /dev/null -w 'ready HTTP %{http_code}\n' http://127.0.0.1:18080/readyz
```

[ sample output ]

```text
curl: (52) Empty reply from server
ready HTTP 000
```

## Write your diagnosis

For each of the three failure IDs, write:

1. the observed symptom;
2. the Pod, event, endpoint, rendered-value, and log evidence that applies;
3. whether Helm intent and live Kubernetes state agree;
4. the smallest repair;
5. the command that will prove recovery.

Do not add a fourth failure. Do not edit the evaluator, app, policy, or chart to
make the symptoms disappear.

## Recover the exact release

After writing your diagnosis, first restore the two live fields to their chart
values. This removes the mutually exclusive literal and ConfigMap forms of
`BACKEND_URL` before Helm reconciles the object.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-api --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/readyz"}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-api patched
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-worker --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/env/1","value":{"name":"BACKEND_URL","valueFrom":{"configMapKeyRef":{"name":"inference-platform","key":"BACKEND_URL","optional":false}}}}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-worker patched
```

Now restore the chart defaults. Helm 4 uses server-side apply, so allow it to
reclaim only the fields changed by these explicit diagnostic patches.

```bash
helm upgrade inference-platform section-9/chart --kube-context kind-agentic-iac-s9 --namespace inference --reset-values --set networkPolicy.enabled=false --force-conflicts --wait --timeout 120s
```

[ sample output ]

```text
Release "inference-platform" has been upgraded.
STATUS: deployed
```

Validate both repaired rollouts.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-api --timeout=120s
```

[ Expected output ]

```text
deployment "inference-platform-api" successfully rolled out
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-worker --timeout=120s
```

[ Expected output ]

```text
deployment "inference-platform-worker" successfully rolled out
```

Check the original host path again.

```bash
curl -sS --retry 5 --retry-all-errors --retry-delay 1 -o /dev/null -w 'ready HTTP %{http_code}\n' http://127.0.0.1:18080/readyz
```

[ Expected output ]

```text
ready HTTP 200
```

NetworkPolicy remains disabled in this core Kind profile. These failures and
repairs do not prove NetworkPolicy enforcement.

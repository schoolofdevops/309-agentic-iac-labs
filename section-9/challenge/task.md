# Advanced Live Diagnostics Lab: Diagnose Three Kubernetes and Helm Failures

Start after the repaired Section 9 release is healthy. Keep the exact cluster
`agentic-iac-s9`, context `kind-agentic-iac-s9`, namespace `inference`, and
release `inference-platform`.

You will inject, observe, diagnose, and recover one failure at a time. Finish
the recovery proof before you continue to the next failure. This keeps each
evidence trail independent.

Do not open the answer key until you have completed all three diagnoses.

## Failure 1: `bad-readiness-path`

### Inject the failure

Change only the live API readiness path. The chart source remains unchanged.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-api --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/ready"}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-api patched
```

### Observe before diagnosis

Wait for the new rollout. The timeout is expected because `/ready` returns
HTTP 404.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-api --timeout=15s
```

[ sample output ]

```text
Waiting for deployment "inference-platform-api" rollout to finish: 1 old replicas are pending termination...
error: timed out waiting for the condition
```

Check both API Pods. The old Pod remains ready while the new Pod fails its
probe.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=api
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-api-...                1/1     Running   0
inference-platform-api-...                0/1     Running   0
```

Read the API warning event.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get events --field-selector type=Warning --sort-by=.metadata.creationTimestamp | command awk 'NR==1 || (/inference-platform-api/ && /statuscode: 404/)'
```

[ sample output ]

```text
LAST SEEN   TYPE      REASON      OBJECT                                        MESSAGE
2s          Warning   Unhealthy   pod/inference-platform-api-56f6f7b545-2d9gp   Readiness probe failed: HTTP probe failed with statuscode: 404
```

Check the API EndpointSlice. Its conditions separate the old ready address
from the new unready address.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpointslices --selector kubernetes.io/service-name=inference-platform-api -o custom-columns='NAME:.metadata.name,ADDRESSES:.endpoints[*].addresses[*],READY:.endpoints[*].conditions.ready'
```

[ sample output ]

```text
NAME                           ADDRESSES                 READY
inference-platform-api-...     10.244.0.5,10.244.0.8    true,false
```

Describe the live Deployment and find the wrong path.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference describe deployment/inference-platform-api
```

[ sample output ]

```text
Readiness:  http-get http://:8080/ready
Available   True
```

Read API logs. A failed kubelet probe may not create an application log line.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference logs --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=api --all-containers --tail=10 --prefix
```

[ sample output ]

```text
(no application log line)
```

Read the Helm render. The release still intends `/readyz`.

```bash
helm get manifest inference-platform --kube-context kind-agentic-iac-s9 --namespace inference | command grep 'path: /readyz'
```

[ sample output ]

```text
path: /readyz
path: /readyz
path: /readyz
```

Do not diagnose until Pod status, rollout status, events, endpoints, live
description, logs, and Helm render are in your notes.

### Write your diagnosis

Record the symptom, the evidence that identifies `/ready`, whether Helm intent
and live state agree, and the smallest repair.

### Recover and prove the repair

Restore only the live API readiness path.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-api --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/readyz"}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-api patched
```

Wait for the API rollout.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-api --timeout=120s
```

[ Expected output ]

```text
deployment "inference-platform-api" successfully rolled out
```

Prove the API Pod and endpoint are ready again.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=api
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-api-...                1/1     Running   0
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpointslices --selector kubernetes.io/service-name=inference-platform-api -o custom-columns='NAME:.metadata.name,ADDRESSES:.endpoints[*].addresses[*],READY:.endpoints[*].conditions.ready'
```

[ sample output ]

```text
NAME                           ADDRESSES                 READY
inference-platform-api-...     10.244.0.5,10.244.0.8    true,false
```

The terminating address can remain briefly. Only the address with `true` is
ready for Service traffic.

```bash
curl -sS -o /dev/null -w 'ready HTTP %{http_code}\n' http://127.0.0.1:18080/readyz
```

[ Expected output ]

```text
ready HTTP 200
```

Do not continue until this recovery passes.

## Failure 2: `unreachable-backend-connection`

### Inject the failure

Point only the live worker at a Service name that does not exist.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-worker --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/env/1","value":{"name":"BACKEND_URL","value":"http://unreachable-backend:8081"}}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-worker patched
```

### Observe before diagnosis

Wait for the new worker rollout. Its dependency-aware readiness must time out.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-worker --timeout=15s
```

[ sample output ]

```text
Waiting for deployment "inference-platform-worker" rollout to finish: 1 old replicas are pending termination...
error: timed out waiting for the condition
```

Check both worker Pods.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=worker
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-worker-...             1/1     Running   0
inference-platform-worker-...             0/1     Running   0
```

Read the worker warning event.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get events --field-selector type=Warning --sort-by=.metadata.creationTimestamp | command awk 'NR==1 || (/inference-platform-worker/ && /statuscode: 503/)'
```

[ sample output ]

```text
LAST SEEN   TYPE      REASON      OBJECT                                           MESSAGE
2s          Warning   Unhealthy   pod/inference-platform-worker-5ddd46c654-sp6j7   Readiness probe failed: HTTP probe failed with statuscode: 503
```

Check the real dependency endpoint. It remains ready, which rules out a failed
dependency Deployment.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpointslices --selector kubernetes.io/service-name=inference-platform-dependencies
```

[ sample output ]

```text
NAME                                    ADDRESSTYPE   PORTS   ENDPOINTS
inference-platform-dependencies-...     IPv4          8081    10.244.0.6
```

Describe the live worker and find the wrong backend URL.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference describe deployment/inference-platform-worker
```

[ sample output ]

```text
BACKEND_URL:  http://unreachable-backend:8081
```

Read logs from both worker Pods. The prefix identifies the failing Pod.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference logs --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=worker --all-containers --tail=10 --prefix
```

[ sample output ]

```text
[pod/inference-platform-worker-.../worker] worker poll failed: ... lookup unreachable-backend ... no such host
```

Read the Helm render. It still uses the ConfigMap reference.

```bash
helm get manifest inference-platform --kube-context kind-agentic-iac-s9 --namespace inference | yq 'select(.kind == "Deployment" and .metadata.name == "inference-platform-worker") | .spec.template.spec.containers[0].env[] | select(.name == "BACKEND_URL")'
```

[ sample output ]

```text
{
  "name": "BACKEND_URL",
  "valueFrom": {
    "configMapKeyRef": {
      "name": "inference-platform",
      "key": "BACKEND_URL"
    }
  }
}
```

Do not diagnose until Pod status, rollout status, events, endpoints, live
description, logs, and Helm render are in your notes.

### Write your diagnosis

Record the symptom, the DNS evidence, why the real dependency endpoint does
not fix the wrong URL, and the smallest repair.

### Recover and prove the repair

Restore only the worker's ConfigMap reference.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference patch deployment/inference-platform-worker --type=json --patch='[{"op":"replace","path":"/spec/template/spec/containers/0/env/1","value":{"name":"BACKEND_URL","valueFrom":{"configMapKeyRef":{"name":"inference-platform","key":"BACKEND_URL"}}}}]'
```

[ Expected output ]

```text
deployment.apps/inference-platform-worker patched
```

Wait for the worker rollout.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-worker --timeout=120s
```

[ Expected output ]

```text
deployment "inference-platform-worker" successfully rolled out
```

Prove the new worker Pod is ready and the dependency endpoint remains ready.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=worker
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-worker-...             1/1     Running   0
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpointslices --selector kubernetes.io/service-name=inference-platform-dependencies
```

[ sample output ]

```text
NAME                                    ADDRESSTYPE   PORTS   ENDPOINTS
inference-platform-dependencies-...     IPv4          8081    10.244.0.6
```

Do not continue until this recovery passes.

## Failure 3: `wrong-helm-value`

### Inject the failure

Change Helm release intent to NodePort `30081`. Kind still forwards host port
`18080` to NodePort `30080`.

```bash
helm upgrade inference-platform section-9/chart --kube-context kind-agentic-iac-s9 --namespace inference --reuse-values --set service.api.nodePort=30081 --force-conflicts --wait --timeout 120s
```

[ sample output ]

```text
Release "inference-platform" has been upgraded. Happy Helming!
STATUS: deployed
```

### Observe before diagnosis

Check the API Pod. This value error does not make the Pod unready.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=api
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-api-...                1/1     Running   0
```

Confirm the API Deployment is available.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-api --timeout=120s
```

[ Expected output ]

```text
deployment "inference-platform-api" successfully rolled out
```

Read events for the changed Service. A Service port update does not create a
Pod probe event.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get events --field-selector involvedObject.kind=Service,involvedObject.name=inference-platform-api
```

[ sample output ]

```text
No resources found in inference namespace.
```

Check the ready API endpoint.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpointslices --selector kubernetes.io/service-name=inference-platform-api
```

[ sample output ]

```text
NAME                           ADDRESSTYPE   PORTS   ENDPOINTS
inference-platform-api-...     IPv4          8080    10.244.0.8
```

Describe the API Deployment. Its probe remains `/readyz`.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference describe deployment/inference-platform-api
```

[ sample output ]

```text
Readiness:  http-get http://:8080/readyz
Available   True
```

Read API logs. There may be no application error because the Pod is healthy.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference logs --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=api --all-containers --tail=10 --prefix
```

[ sample output ]

```text
(no application error)
```

Read the stored Helm value and rendered Service.

```bash
helm get values inference-platform --kube-context kind-agentic-iac-s9 --namespace inference --all | command awk '/nodePort:/{print "nodePort:", $2; exit}'
```

[ sample output ]

```text
nodePort: 30081
```

```bash
helm get manifest inference-platform --kube-context kind-agentic-iac-s9 --namespace inference | command awk '/nodePort:/{print "nodePort:", $2; exit}'
```

[ sample output ]

```text
nodePort: 30081
```

Read the live Service.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get service inference-platform-api
```

[ sample output ]

```text
NAME                     TYPE       PORT(S)
inference-platform-api   NodePort   8080:30081/TCP
```

Observe the broken host path without hiding the curl result.

```bash
curl -sS -o /dev/null -w 'ready HTTP %{http_code}\n' http://127.0.0.1:18080/readyz
```

[ sample output ]

```text
curl: (52) Empty reply from server
ready HTTP 000
```

Do not diagnose until Pod status, rollout status, events, endpoints, live
description, logs, Helm values, Helm render, Service, and curl are in your
notes.

### Write your diagnosis

Record why healthy Pods and endpoints do not prove the host-to-NodePort path,
where `30081` became Helm intent, and the smallest repair.

### Recover and prove the repair

Reset the release to the reviewed chart values. `--force-conflicts` lets Helm 4
reclaim only fields changed by this controlled diagnostic flow.

```bash
helm upgrade inference-platform section-9/chart --kube-context kind-agentic-iac-s9 --namespace inference --reset-values --set networkPolicy.enabled=false --force-conflicts --wait --timeout 120s
```

[ sample output ]

```text
Release "inference-platform" has been upgraded. Happy Helming!
STATUS: deployed
```

Prove the healthy API rollout and ready endpoint remain intact.

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference rollout status deployment/inference-platform-api --timeout=120s
```

[ Expected output ]

```text
deployment "inference-platform-api" successfully rolled out
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get pods --selector app.kubernetes.io/name=inference-platform,app.kubernetes.io/component=api
```

[ sample output ]

```text
NAME                                      READY   STATUS    RESTARTS
inference-platform-api-...                1/1     Running   0
```

```bash
command kubectl --context kind-agentic-iac-s9 --namespace inference get endpointslices --selector kubernetes.io/service-name=inference-platform-api
```

[ sample output ]

```text
NAME                           ADDRESSTYPE   PORTS   ENDPOINTS
inference-platform-api-...     IPv4          8080    10.244.0.8
```

Read the restored render.

```bash
helm get manifest inference-platform --kube-context kind-agentic-iac-s9 --namespace inference | command awk '/nodePort:/{print "nodePort:", $2; exit}'
```

[ Expected output ]

```text
nodePort: 30080
```

Check the original host path.

```bash
curl -sS --retry 5 --retry-all-errors --retry-delay 1 -o /dev/null -w 'ready HTTP %{http_code}\n' http://127.0.0.1:18080/readyz
```

[ Expected output ]

```text
ready HTTP 200
```

All three failures are now independently diagnosed and recovered.
NetworkPolicy remains disabled in this core Kind profile. This challenge does
not prove NetworkPolicy enforcement.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EXACT,
  assertApprovedRevision,
  assertApprovalUnchanged,
  assertLaterApprovalsAbsent,
  assertApplicationContract,
  assertRuntimeNames,
  captureKubernetesEvidence,
  capturePreRunInventory,
  commandEnvironment,
  deadlineAction,
  execute,
  executeWithHardTimeout,
  requiredArgoImages,
  transportTagFor,
  normalizeNodeImageReference,
  openApprovalGate,
  recordPeak,
  removeOwnedApprovalGate,
  verifyRevisionLineage,
  waitForApprovedRevision,
  workloadRolloutTargets,
} from "../scripts/run-gitops-lifecycle.mjs";
import * as lifecycle from "../scripts/run-gitops-lifecycle.mjs";

const sectionRoot = new URL("../", import.meta.url);

test("the frozen runtime names are the Section 10 names", () => {
  assert.deepEqual(EXACT, {
    cluster: "agentic-iac-s10",
    context: "kind-agentic-iac-s10",
    node: "agentic-iac-s10-control-plane",
    argocdNamespace: "argocd",
    workloadNamespace: "inference",
    release: "argocd",
    application: "inference-platform",
    gitContainer: "agentic-iac-s10-git",
  });
  assert.doesNotThrow(() => assertRuntimeNames(EXACT));
  assert.throws(() => assertRuntimeNames({ ...EXACT, cluster: "other" }), /RUNTIME_NAME_MISMATCH/);
});

test("the learner runtime selects Docker and includes the verified canonical Rancher CLI directory", () => {
  const trustedTemp = realpathSync(tmpdir());
  const originalTemp = process.env.TMPDIR;
  const originalDockerHost = process.env.DOCKER_HOST;
  const originalDockerContext = process.env.DOCKER_CONTEXT;
  process.env.TMPDIR = "/attacker-controlled-temp";
  process.env.DOCKER_HOST = "unix:///attacker.sock";
  process.env.DOCKER_CONTEXT = "attacker";
  const environment = commandEnvironment();
  if (originalTemp == null) delete process.env.TMPDIR; else process.env.TMPDIR = originalTemp;
  if (originalDockerHost == null) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = originalDockerHost;
  if (originalDockerContext == null) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = originalDockerContext;
  assert.equal(environment.KIND_EXPERIMENTAL_PROVIDER, "docker");
  assert.equal(environment.TMPDIR, trustedTemp);
  assert.equal(environment.DOCKER_HOST, `unix://${userInfo().homedir}/.rd/docker.sock`);
  assert.equal(environment.DOCKER_CONTEXT, undefined);
  assert.match(environment.PATH, /^\/Applications\/Rancher Desktop\.app\/Contents\/Resources\/resources\/darwin\/bin:/);
  assert.doesNotMatch(environment.PATH, /\/\.rd\/bin/);
});

test("the shipped Application is manual and points at the read-only course mirror", () => {
  const manifest = readFileSync(new URL("argocd/application.yaml", sectionRoot), "utf8");
  assert.doesNotThrow(() => assertApplicationContract(manifest));
});

test("pre-run inventory records exact image and Helm cache facts without leaking cache paths", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-cache-inventory-"));
  const repositoryCache = join(root, "repository");
  const contentCache = join(root, "content");
  const repositoryConfig = join(root, "repositories.yaml");
  const chartDigest = "5abb71c17bc082e13dc3d90023972f871ea8e1dfc26d8f3218ceade215b971d5";
  mkdirSync(join(contentCache, chartDigest.slice(0, 2)), { recursive: true });
  mkdirSync(repositoryCache, { recursive: true });
  writeFileSync(repositoryConfig, "repositories: []\n");
  writeFileSync(join(repositoryCache, "argo-index.yaml"), "safe index\n");
  writeFileSync(join(repositoryCache, "argo-charts.txt"), "safe chart list\n");
  writeFileSync(join(contentCache, chartDigest.slice(0, 2), `${chartDigest}.chart`), "cached chart bytes\n");
  const presentId = `sha256:${"a".repeat(64)}`;
  const executor = (tool, args) => {
    if (tool === "helm" && args[0] === "env") return { exit: 0, stdout: [
      `HELM_CONTENT_CACHE=${JSON.stringify(contentCache)}`,
      `HELM_REPOSITORY_CACHE=${JSON.stringify(repositoryCache)}`,
      `HELM_REPOSITORY_CONFIG=${JSON.stringify(repositoryConfig)}`,
    ].join("\n"), stderr: "" };
    if (tool === "helm" && args[0] === "repo") return { exit: 0, stdout: JSON.stringify([
      { name: "private", url: "https://token@private.invalid/charts" },
      { name: "argo", url: "https://argoproj.github.io/argo-helm" },
    ]), stderr: "" };
    if (tool === "docker" && args[0] === "image" && args[1] === "inspect") {
      const reference = args[2];
      if (reference.endsWith(":s10-v2")) return { exit: 1, stdout: "", stderr: "No such image" };
      return { exit: 0, stdout: JSON.stringify({ id: presentId, repo_digests: [`${reference}@sha256:${"b".repeat(64)}`], architecture: "arm64", size: 1234 }), stderr: "" };
    }
    throw new Error(`unexpected command: ${tool} ${args.join(" ")}`);
  };
  const inventory = capturePreRunInventory({ executor, trustedHome: root, now: () => 1_788_134_400_000 });
  assert.equal(inventory.schema, "agentic-iac-s10-pre-run-inventory/v1");
  assert.equal(inventory.observed_at, "2026-08-31T00:00:00.000Z");
  assert.equal(inventory.images.length, 8);
  assert.equal(inventory.images.find((image) => image.reference.endsWith(":s10-v2")).present, false);
  assert.equal(inventory.images.find((image) => image.reference.startsWith("kindest/node@")).identity.id, presentId);
  assert.deepEqual(inventory.helm.repository, { name: "argo", url: "https://argoproj.github.io/argo-helm", configured: true });
  assert.equal(inventory.helm.chart.version, "10.4.0");
  assert.equal(inventory.helm.chart.content_cache.present, true);
  assert.equal(inventory.helm.chart.content_cache.sha256, "b7f101c5e092998032fae488de7312feb9e4bac0cb89edb78a0baee139d92a57");
  assert.equal(inventory.helm.chart.content_cache.identity_matches_expected, false);
  assert.equal(inventory.helm.repository_index.present, true);
  assert.equal(inventory.helm.repository_chart_list.present, true);
  assert.doesNotMatch(JSON.stringify(inventory), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(inventory), /private\.invalid|token@/);
  rmSync(root, { recursive: true });
});

test("pre-run inventory records absent image and Helm caches on a clean host", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-empty-cache-"));
  const executor = (tool, args) => {
    if (tool === "docker") return { exit: 1, stdout: "", stderr: "No such image" };
    if (tool === "helm" && args[0] === "env") return { exit: 0, stdout: [
      `HELM_CONTENT_CACHE=${JSON.stringify(join(root, "missing-content"))}`,
      `HELM_REPOSITORY_CACHE=${JSON.stringify(join(root, "missing-repository"))}`,
      `HELM_REPOSITORY_CONFIG=${JSON.stringify(join(root, "missing-config", "repositories.yaml"))}`,
    ].join("\n"), stderr: "" };
    if (tool === "helm" && args[0] === "repo") return { exit: 0, stdout: "[]", stderr: "" };
    throw new Error("unexpected command");
  };
  const inventory = capturePreRunInventory({ executor, trustedHome: root });
  assert.ok(inventory.images.every((image) => image.present === false));
  assert.equal(inventory.helm.repository.configured, false);
  assert.equal(inventory.helm.repository_config.present, false);
  assert.equal(inventory.helm.repository_index.present, false);
  assert.equal(inventory.helm.repository_chart_list.present, false);
  assert.deepEqual(inventory.helm.chart.content_cache, { present: false, identity_matches_expected: false });
  assert.doesNotMatch(JSON.stringify(inventory), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const unavailable = (tool, args) => tool === "docker"
    ? { exit: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
    : executor(tool, args);
  assert.throws(() => capturePreRunInventory({ executor: unavailable, trustedHome: root }), /IMAGE_CACHE_OBSERVATION_FAILED/);
  rmSync(root, { recursive: true });
});

const kubernetesLogTargets = [
  { namespace: "argocd", component: "application-controller", workloadKind: "StatefulSet", workload: "argocd-application-controller", container: "application-controller", pod: "argocd-application-controller-0" },
  { namespace: "argocd", component: "applicationset-controller", workloadKind: "Deployment", workload: "argocd-applicationset-controller", container: "applicationset-controller", pod: "argocd-applicationset-controller-7c9f8b6c45-q2vwx" },
  { namespace: "argocd", component: "redis", workloadKind: "Deployment", workload: "argocd-redis", container: "redis", pod: "argocd-redis-6f7d8c9b45-r4nd0" },
  { namespace: "argocd", component: "repo-server", workloadKind: "Deployment", workload: "argocd-repo-server", container: "repo-server", pod: "argocd-repo-server-5b8c7d6f49-p9x2k" },
  { namespace: "argocd", component: "server", workloadKind: "Deployment", workload: "argocd-server", container: "server", pod: "argocd-server-8d6f7b5c49-z1m3n" },
  { namespace: "inference", component: "api", workloadKind: "Deployment", workload: "inference-platform-api", container: "api", pod: "inference-platform-api-765d9f8b4c-t6h2j" },
  { namespace: "inference", component: "dependencies", workloadKind: "Deployment", workload: "inference-platform-dependencies", container: "dependencies", pod: "inference-platform-dependencies-6c8d7f5b49-w4p7s" },
  { namespace: "inference", component: "worker", workloadKind: "Deployment", workload: "inference-platform-worker", container: "worker", pod: "inference-platform-worker-9b7d6c5f48-k8v3q" },
];

function targetLabels(target, { workload = false } = {}) {
  if (target.namespace === "argocd") return {
    "app.kubernetes.io/name": target.workload,
    "app.kubernetes.io/instance": "argocd",
    "app.kubernetes.io/component": target.component,
    "app.kubernetes.io/managed-by": "Helm",
    "app.kubernetes.io/part-of": "argocd",
    "app.kubernetes.io/version": "v3.5.1",
    "helm.sh/chart": "argo-cd-10.4.0",
  };
  return {
    "app.kubernetes.io/name": "inference-platform",
    "app.kubernetes.io/component": target.component,
    ...(workload ? { "app.kubernetes.io/managed-by": "Helm" } : {}),
  };
}

function kubernetesEvidenceFixture({ mutatePods = (pods) => pods, failLogs = false } = {}) {
  const calls = { logs: [], raw: [] };
  const resources = new Map();
  const pods = Object.fromEntries(["argocd", "inference"].map((namespace) => [namespace, []]));
  for (const [index, target] of kubernetesLogTargets.entries()) {
    const workloadUid = `workload-uid-${index}`;
    const workloadResource = target.workloadKind === "Deployment" ? "deployments" : "statefulsets";
    resources.set(`/apis/apps/v1/namespaces/${target.namespace}/${workloadResource}/${target.workload}`, {
      apiVersion: "apps/v1", kind: target.workloadKind,
      metadata: { namespace: target.namespace, name: target.workload, uid: workloadUid, labels: targetLabels(target, { workload: true }) },
      spec: { selector: { matchLabels: targetLabels(target) }, template: { metadata: { labels: targetLabels(target) }, spec: { containers: [{ name: target.container }] } } },
    });
    let owner = { apiVersion: "apps/v1", kind: target.workloadKind, name: target.workload, uid: workloadUid, controller: true, blockOwnerDeletion: true };
    const labels = { ...targetLabels(target) };
    if (target.workloadKind === "Deployment") {
      const replicaSet = `${target.workload}-rs-${index}`;
      const replicaSetUid = `replicaset-uid-${index}`;
      owner = { apiVersion: "apps/v1", kind: "ReplicaSet", name: replicaSet, uid: replicaSetUid, controller: true, blockOwnerDeletion: true };
      resources.set(`/apis/apps/v1/namespaces/${target.namespace}/replicasets/${replicaSet}`, {
        apiVersion: "apps/v1", kind: "ReplicaSet",
        metadata: {
          namespace: target.namespace, name: replicaSet, uid: replicaSetUid,
          labels: { ...labels, "pod-template-hash": `hash-${index}` },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: target.workload, uid: workloadUid, controller: true, blockOwnerDeletion: true }],
        },
        spec: { selector: { matchLabels: { ...labels, "pod-template-hash": `hash-${index}` } }, template: { metadata: { labels } } },
      });
      labels["pod-template-hash"] = `hash-${index}`;
    }
    pods[target.namespace].push({
      metadata: { namespace: target.namespace, name: target.pod, uid: `pod-uid-${index}`, labels, ownerReferences: [owner] },
      spec: { containers: [{ name: target.container, image: "example.invalid/course@sha256:deadbeef" }] },
      status: { phase: "Running", containerStatuses: [{ name: target.container, ready: true, restartCount: 0 }] },
    });
  }
  const mutatedPods = mutatePods(structuredClone(pods));
  const event = (namespace, name) => ({
    apiVersion: "v1", kind: "Event",
    metadata: { namespace, name, creationTimestamp: "2026-08-31T00:00:00Z" },
    involvedObject: { kind: "Pod", name }, reason: "Started", type: "Normal", count: 1,
    message: "token=s10-runtime-token path=/Users/author/course Authorization: Bearer abc.def.ghi",
  });
  const executor = (tool, args) => {
    assert.equal(tool, "kubectl");
    if (args.includes("logs")) {
      calls.logs.push(args);
      if (failLogs) throw new Error("log transport failed");
      return { exit: 0, stdout: args.includes("application-controller") ? "x".repeat(16_384) : "2026-08-31T00:00:00Z token=s10-runtime-token reading /private/var/folders/secret\nready", stderr: "" };
    }
    const raw = args.at(-1);
    calls.raw.push(raw);
    const url = new URL(raw, "https://kubernetes.invalid");
    const eventMatch = url.pathname.match(/^\/api\/v1\/namespaces\/([^/]+)\/events$/);
    if (eventMatch) return { exit: 0, stdout: JSON.stringify({ apiVersion: "v1", kind: "EventList", metadata: { continue: "" }, items: [event(eventMatch[1], `${eventMatch[1]}-pod`)] }), stderr: "" };
    const podMatch = url.pathname.match(/^\/api\/v1\/namespaces\/([^/]+)\/pods$/);
    if (podMatch) return { exit: 0, stdout: JSON.stringify({ apiVersion: "v1", kind: "PodList", metadata: { continue: "" }, items: mutatedPods[podMatch[1]] }), stderr: "" };
    const resource = resources.get(url.pathname);
    if (resource) return { exit: 0, stdout: JSON.stringify(resource), stderr: "" };
    throw new Error(`unexpected kubectl arguments: ${args.join(" ")}`);
  };
  return { calls, executor, pods: mutatedPods };
}

test("pre-cleanup evidence validates eight stable owners before capturing dynamic-Pod logs", () => {
  const { calls, executor } = kubernetesEvidenceFixture();
  const evidence = captureKubernetesEvidence({ executor, now: () => 1_788_134_400_000 });
  assert.equal(evidence.schema, "agentic-iac-s10-kubernetes-evidence/v1");
  assert.equal(evidence.events.length, 2);
  assert.ok(evidence.events.every((entry) => entry.complete === true && entry.server_limit === 100 && entry.total_returned === 1));
  assert.equal(evidence.logs.length, 8);
  assert.equal(calls.logs.length, 8);
  assert.deepEqual(evidence.logs.map((entry) => entry.target_id).sort(), kubernetesLogTargets.map((target) => `${target.namespace}/${target.workload}`).sort());
  assert.deepEqual(evidence.logs.map((entry) => entry.pod).sort(), kubernetesLogTargets.map((target) => target.pod).sort());
  assert.ok(evidence.logs.every((entry) => ["Deployment", "StatefulSet"].includes(entry.owner.kind) && entry.owner.name === entry.workload));
  assert.ok(evidence.logs.every((entry) => entry.tail_lines === 200 && entry.limit_bytes === 16384 && /^[0-9a-f]{64}$/.test(entry.sanitized_sha256)));
  assert.equal(evidence.logs.find((entry) => entry.container === "application-controller").source_limit_reached, true);
  assert.equal(evidence.logs.find((entry) => entry.container === "api").source_limit_reached, false);
  assert.ok(evidence.logs.every((entry) => typeof entry.sanitizer_truncated === "boolean" && !("truncated" in entry)));
  assert.doesNotMatch(JSON.stringify(evidence), /s10-runtime-token|\/Users\/|\/private\/var|Bearer abc|token=/i);
  assert.match(JSON.stringify(evidence), /REDACTED/);
});

test("pre-cleanup evidence rejects a missing expected component before reading any log", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { pods.inference = pods.inference.filter((pod) => pod.metadata.labels["app.kubernetes.io/component"] !== "worker"); return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence rejects an unexpected sidecar before reading any log", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { pods.inference[0].spec.containers.push({ name: "unreviewed-sidecar", image: "attacker.invalid/sidecar:latest" }); return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence rejects an extra Pod before reading any log", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { pods.argocd.push(structuredClone(pods.argocd[1])); pods.argocd.at(-1).metadata.name = "argocd-applicationset-controller-extra-pod"; pods.argocd.at(-1).metadata.uid = "extra-pod-uid"; return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence rejects a replaced expected container before reading any log", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { pods.argocd[2].spec.containers = [{ name: "arbitrary-container", image: "attacker.invalid/arbitrary:latest" }]; return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence rejects duplicate stable target identities before reading any log", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { pods.argocd[4] = structuredClone(pods.argocd[1]); pods.argocd[4].metadata.name = "argocd-applicationset-controller-second-dynamic-pod"; pods.argocd[4].metadata.uid = "duplicate-pod-uid"; return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence rejects a Pod whose owner does not resolve to the stable workload", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { pods.inference[1].metadata.ownerReferences[0].name = "foreign-replicaset"; return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence rejects a Pod missing an exact course identity label", () => {
  const fixture = kubernetesEvidenceFixture({ mutatePods: (pods) => { delete pods.argocd[3].metadata.labels["app.kubernetes.io/managed-by"]; return pods; } });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 0);
});

test("pre-cleanup evidence fails closed when any required container log cannot be captured", () => {
  const fixture = kubernetesEvidenceFixture({ failLogs: true });
  assert.throws(() => captureKubernetesEvidence({ executor: fixture.executor }), /KUBERNETES_EVIDENCE_CAPTURE_FAILED/);
  assert.equal(fixture.calls.logs.length, 1);
});

test("approval binds independent human reviewer to one exact revision and purpose", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-test-"));
  const path = join(root, "approval.json");
  const revision = "1".repeat(40);
  writeFileSync(path, `${JSON.stringify({
    schema: "agentic-iac-s10-human-approval/v1",
    approved_by: "human-platform-reviewer",
    requested_by: "agent-author",
    revision,
    purpose: "promote-v1",
    approved: true,
  })}\n`);
  const approved = assertApprovedRevision(path, revision, "promote-v1");
  assert.deepEqual(Object.keys(approved).sort(), ["approved", "approved_by", "file", "purpose", "requested_by", "revision", "schema"].sort());
  assert.deepEqual(Object.keys(approved.file).sort(), ["birthtime", "bytes", "ctime", "device", "identity_sha256", "inode", "mtime"].sort());
  assert.throws(() => assertApprovedRevision(path, "2".repeat(40), "promote-v1"), /UNAPPROVED_REVISION/);
  assert.throws(() => assertApprovedRevision(path, revision, "promote-v2"), /APPROVAL_PURPOSE_MISMATCH/);
  rmSync(root, { recursive: true });
});

test("approval schema rejects extra token or path keys and never serializes them", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-schema-"));
  const path = join(root, "approval.json");
  const base = { schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author", revision: "3".repeat(40), purpose: "promote-v2", approved: true };
  for (const extra of [{ token: "must-not-survive" }, { local_path: "/must/not/survive" }]) {
    writeFileSync(path, `${JSON.stringify({ ...base, ...extra })}\n`, { mode: 0o600 });
    assert.throws(() => assertApprovedRevision(path, base.revision, base.purpose), /APPROVAL_KEYS_INVALID/);
  }
  writeFileSync(path, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  const evidence = assertApprovedRevision(path, base.revision, base.purpose);
  assert.doesNotMatch(JSON.stringify(evidence), /must-not-survive|must\/not\/survive|local_path|token/);
  rmSync(root, { recursive: true });
});

test("later approvals must be absent initially and a newly created exact record advances after its gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-late-approval-"));
  const v2 = join(root, "v2.json");
  const revert = join(root, "revert.json");
  const revision = "4".repeat(40);
  for (const preloaded of [v2, revert]) {
    writeFileSync(preloaded, "{}\n", { mode: 0o600 });
    assert.throws(() => assertLaterApprovalsAbsent([v2, revert]), /PRELOADED_LATER_APPROVAL/);
    rmSync(preloaded);
  }
  assert.doesNotThrow(() => assertLaterApprovalsAbsent([v2, revert]));
  const gate = openApprovalGate(v2, revision, "promote-v2", { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "3".repeat(40) });
  const gateMs = gate.openedAtMs;
  setTimeout(() => writeFileSync(v2, `${JSON.stringify({ schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author", revision, purpose: "promote-v2", approved: true })}\n`, { mode: 0o600 }), 20);
  const observed = await waitForApprovedRevision(v2, revision, "promote-v2", { gateBinding: gate.binding, gateMs, timeoutMs: 500, pollMs: 5 });
  assert.equal(observed.revision, revision);
  assert.ok(Date.parse(observed.file.mtime) >= gateMs);
  assert.match(observed.file.identity_sha256, /^[0-9a-f]{64}$/);
  removeOwnedApprovalGate(gate.ownership);
  rmSync(root, { recursive: true });
});

test("an external approval simulator can be cancelled when the runner fails before a gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-cancelled-simulator-"));
  const gate = join(root, "never-created.gate.json");
  const program = `
    const fs=require("node:fs");
    let stopped=false;
    process.on("SIGTERM",()=>{stopped=true});
    process.stdout.write("ready\\n");
    const deadline=Date.now()+10_000;
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    (async()=>{
      while(!fs.existsSync(${JSON.stringify(gate)})) {
        if(stopped || Date.now()>deadline) throw new Error("approval simulator stopped");
        await sleep(10);
      }
    })().catch(error=>{console.error(error.message);process.exitCode=2});
  `;
  const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await Promise.race([
    new Promise((resolve) => child.stdout.on("data", () => stdout.includes("ready\n") && resolve())),
    new Promise((_, reject) => setTimeout(() => reject(new Error("simulator startup hung")), 2_000)),
  ]);
  child.kill("SIGTERM");
  const outcome = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("simulator cancellation hung")), 2_000)),
  ]);
  assert.deepEqual(outcome, { code: 2, signal: null });
  assert.match(stderr, /approval simulator stopped/);
  assert.equal(existsSync(gate), false);
  rmSync(root, { recursive: true });
});

test("approval acceptance does not depend on Linux filesystems reporting birth time", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-zero-birthtime-"));
  const path = join(root, "approval.json");
  const value = { schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author", revision: "5".repeat(40), purpose: "promote-v2", approved: true };
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const real = lstatSync(path);
  const linuxStyleStat = () => new Proxy(real, { get: (target, key) => key === "birthtimeMs" ? 0 : key === "birthtime" ? new Date(0) : Reflect.get(target, key, target) });
  const approved = assertApprovedRevision(path, value.revision, value.purpose, { stat: linuxStyleStat });
  assert.equal(approved.file.birthtime, null);
  assert.match(approved.file.identity_sha256, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true });
});

test("an accepted approval must remain byte-identical until the explicit sync", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-recheck-"));
  const path = join(root, "approval.json");
  const value = { schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author", revision: "6".repeat(40), purpose: "promote-v2", approved: true };
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const accepted = assertApprovedRevision(path, value.revision, value.purpose);
  assert.doesNotThrow(() => assertApprovalUnchanged(path, value.revision, value.purpose, accepted));
  writeFileSync(path, `${JSON.stringify({ ...value, approved: false })}\n`, { mode: 0o600 });
  assert.throws(() => assertApprovalUnchanged(path, value.revision, value.purpose, accepted), /APPROVAL_CHANGED_AFTER_ACCEPTANCE|APPROVAL_RECORD_INVALID/);
  rmSync(root, { recursive: true });
});

test("final cleanup removes only unchanged runner-owned approval gates", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-cleanup-"));
  const v2Approval = join(root, "v2.json");
  const v2Gate = openApprovalGate(v2Approval, "7".repeat(40), "promote-v2", { sync: "Synced", health: "Healthy", operation: "Succeeded" });
  const v2GatePath = `${v2Approval}.gate.json`;
  assert.equal(existsSync(v2GatePath), true);
  removeOwnedApprovalGate(v2Gate.ownership);
  assert.equal(existsSync(v2GatePath), false);

  const recoveryApproval = join(root, "revert.json");
  const recoveryGate = openApprovalGate(recoveryApproval, "8".repeat(40), "revert-and-recover", { sync: "OutOfSync", replicas_after_15_seconds: 2 });
  const recoveryGatePath = `${recoveryApproval}.gate.json`;
  writeFileSync(recoveryGatePath, "foreign replacement\n", { mode: 0o600 });
  assert.throws(() => removeOwnedApprovalGate(recoveryGate.ownership), /APPROVAL_GATE_OWNERSHIP_CHANGED/);
  assert.equal(existsSync(recoveryGatePath), true);
  rmSync(root, { recursive: true });
});

test("runner binds the original gate directory and rejects a same-content gate replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-binding-"));
  try {
    const approval = join(root, "v2.json");
    const opened = openApprovalGate(approval, "9".repeat(40), "promote-v2", { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "8".repeat(40) });
    const gate = `${approval}.gate.json`;
    const original = readFileSync(gate, "utf8");
    rmSync(gate);
    writeFileSync(gate, original, { mode: 0o600 });
    assert.throws(() => lifecycle.assertApprovalGateBinding(opened.binding), /APPROVAL_GATE_BINDING_CHANGED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner rejects parent or ancestor replacement before an approval can advance", () => {
  const outer = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-parent-"));
  try {
    const parent = join(outer, "approval-parent");
    mkdirSync(parent);
    const approval = join(parent, "v2.json");
    const opened = openApprovalGate(approval, "a".repeat(40), "promote-v2", { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "9".repeat(40) });
    const moved = `${parent}-moved`;
    renameSync(parent, moved);
    mkdirSync(parent);
    assert.throws(() => lifecycle.assertApprovalGateBinding(opened.binding), /APPROVAL_GATE_BINDING_CHANGED/);

    rmSync(parent, { recursive: true });
    renameSync(moved, parent);
    const outerMoved = `${outer}-moved`;
    renameSync(outer, outerMoved);
    mkdirSync(outer);
    mkdirSync(parent, { recursive: true });
    assert.throws(() => lifecycle.assertApprovalGateBinding(opened.binding), /APPROVAL_GATE_BINDING_CHANGED/);
    rmSync(outerMoved, { recursive: true, force: true });
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("pre-sync gate substitution prevents every sync command", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-presync-binding-"));
  try {
    const approval = join(root, "v2.json");
    const opened = openApprovalGate(approval, "b".repeat(40), "promote-v2", { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "a".repeat(40) });
    const gate = `${approval}.gate.json`;
    const original = readFileSync(gate, "utf8");
    rmSync(gate);
    writeFileSync(gate, original, { mode: 0o600 });
    const calls = [];
    assert.throws(() => lifecycle.explicitSync("b".repeat(40), [], { gateBinding: opened.binding, executor: (...args) => calls.push(args) }), /APPROVAL_GATE_BINDING_CHANGED/);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval wait refuses a substituted runner gate before accepting an exact record", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-wait-binding-"));
  try {
    const approval = join(root, "v2.json");
    const revision = "c".repeat(40);
    const opened = openApprovalGate(approval, revision, "promote-v2", { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "b".repeat(40) });
    const gate = `${approval}.gate.json`;
    const original = readFileSync(gate, "utf8");
    rmSync(gate);
    writeFileSync(gate, original, { mode: 0o600 });
    writeFileSync(approval, `${JSON.stringify({ schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author", revision, purpose: "promote-v2", approved: true })}\n`, { mode: 0o600 });
    await assert.rejects(() => waitForApprovedRevision(approval, revision, "promote-v2", { gateBinding: opened.binding, gateMs: opened.openedAtMs, timeoutMs: 50, pollMs: 1 }), /APPROVAL_GATE_BINDING_CHANGED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revision lineage requires direct v1-v2-recovery ancestry and a true tree recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-lineage-"));
  spawnSync("git", ["init", "-q", root]);
  spawnSync("git", ["-C", root, "config", "user.name", "Lifecycle Test"]);
  spawnSync("git", ["-C", root, "config", "user.email", "lifecycle@example.invalid"]);
  writeFileSync(join(root, "version.txt"), "v1\n");
  spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "v1"]);
  const v1 = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(root, "version.txt"), "v2\n");
  spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "v2"]);
  const v2 = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", root, "revert", "--no-edit", v2]);
  const recovery = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const lineage = verifyRevisionLineage(root, { v1, v2, revert: recovery }, []);
  assert.equal(lineage.v2.parent, v1);
  assert.equal(lineage.recovery.parent, v2);
  assert.equal(lineage.recovery.tree, lineage.v1.tree);
  assert.notEqual(lineage.v2.tree, lineage.v1.tree);
  assert.match(lineage.v1_to_v2.raw_delta_sha256, /^[0-9a-f]{64}$/);
  spawnSync("git", ["-C", root, "checkout", "-q", "--orphan", "unrelated"]);
  rmSync(join(root, "version.txt"));
  mkdirSync(join(root, "branch"));
  writeFileSync(join(root, "branch", "other.txt"), "other\n");
  spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "unrelated"]);
  const unrelated = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.throws(() => verifyRevisionLineage(root, { v1, v2: unrelated, revert: recovery }, []), /V2_NOT_DIRECT_SUCCESSOR/);
  rmSync(root, { recursive: true });
});

test("revision lineage ignores replacement objects, poisoned diff drivers, attributes, and caller Git config", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-poisoned-lineage-"));
  spawnSync("git", ["init", "-q", root]);
  spawnSync("git", ["-C", root, "config", "user.name", "Lifecycle Test"]);
  spawnSync("git", ["-C", root, "config", "user.email", "lifecycle@example.invalid"]);
  writeFileSync(join(root, "version.txt"), "v1\n");
  spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "v1"]);
  const v1 = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(root, "version.txt"), "v2\n");
  spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "v2"]);
  const v2 = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const originalV2Tree = spawnSync("git", ["-C", root, "show", "-s", "--format=%T", v2], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", root, "revert", "--no-edit", v2]);
  const recovery = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const marker = join(root, "poison-executed");
  const poison = join(root, "poison.sh");
  writeFileSync(poison, `#!/bin/sh\nprintf poison > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  chmodSync(poison, 0o700);
  spawnSync("git", ["-C", root, "config", "diff.external", poison]);
  spawnSync("git", ["-C", root, "config", "diff.evil.textconv", poison]);
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  writeFileSync(join(root, ".git", "info", "attributes"), "*.txt diff=evil\n");
  spawnSync("git", ["-C", root, "replace", v2, recovery]);
  const poisonGlobal = join(root, "global.gitconfig");
  writeFileSync(poisonGlobal, `[diff]\n\texternal = ${poison}\n`);
  const previous = { external: process.env.GIT_EXTERNAL_DIFF, global: process.env.GIT_CONFIG_GLOBAL, noReplace: process.env.GIT_NO_REPLACE_OBJECTS };
  process.env.GIT_EXTERNAL_DIFF = poison;
  process.env.GIT_CONFIG_GLOBAL = poisonGlobal;
  delete process.env.GIT_NO_REPLACE_OBJECTS;
  try {
    const lineage = verifyRevisionLineage(root, { v1, v2, revert: recovery }, []);
    assert.equal(lineage.v2.tree, originalV2Tree);
    assert.equal(existsSync(marker), false);
    assert.match(lineage.v1_to_v2.raw_delta_sha256, /^[0-9a-f]{64}$/);
  } finally {
    if (previous.external == null) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = previous.external;
    if (previous.global == null) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous.global;
    if (previous.noReplace == null) delete process.env.GIT_NO_REPLACE_OBJECTS; else process.env.GIT_NO_REPLACE_OBJECTS = previous.noReplace;
    rmSync(root, { recursive: true });
  }
});

test("resource sampling records the named node peak and rejects excess workload", () => {
  const measurements = { samples: [], peak_bytes: 0 };
  recordPeak(measurements, { node: EXACT.node, bytes: 1_500_000_000, at: "2026-08-29T00:00:00Z" });
  recordPeak(measurements, { node: EXACT.node, bytes: 2_000_000_000, at: "2026-08-29T00:00:01Z" });
  assert.equal(measurements.peak_bytes, 2_000_000_000);
  assert.equal(measurements.samples.length, 2);
  assert.throws(() => recordPeak(measurements, { node: "other", bytes: 1, at: "x" }), /SAMPLE_NODE_MISMATCH/);
  assert.throws(() => recordPeak(measurements, { node: EXACT.node, bytes: 4 * 1024 ** 3 + 1, at: "x" }), /RESOURCE_LIMIT_EXCEEDED/);
});

test("the compact profile renders five one-replica controllers with bounded ApplicationSet resources", () => {
  const result = spawnSync("helm", ["template", "argocd", "argo/argo-cd", "--version", "10.4.0", "--namespace", "argocd", "-f", new URL("argocd/values.yaml", sectionRoot).pathname], { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const workloads = [...result.stdout.matchAll(/^kind: (Deployment|StatefulSet)\n[\s\S]*?^metadata:\n  name: (argocd-(?:application-controller|applicationset-controller|repo-server|server|redis))$/gm)];
  assert.equal(workloads.length, 5);
  const appset = result.stdout.match(/^kind: Deployment\n[\s\S]*?^metadata:\n  name: argocd-applicationset-controller$[\s\S]*?(?=\n---\n)/m)?.[0] ?? "";
  assert.match(appset, /requests:\n\s+cpu: 25m\n\s+memory: 64Mi/);
  assert.match(appset, /limits:\n\s+cpu: 200m\n\s+memory: 256Mi/);
});

test("the pinned render freezes the exact two Argo runtime images", () => {
  const result = spawnSync("helm", ["template", "argocd", "argo/argo-cd", "--version", "10.4.0", "--namespace", "argocd", "-f", new URL("argocd/values.yaml", sectionRoot).pathname], { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requiredArgoImages(result.stdout), [
    "ecr-public.aws.com/docker/library/redis:8.6.4-alpine",
    "quay.io/argoproj/argocd:v3.5.1",
  ]);
});

test("multi-platform Argo sources map only to bounded single-platform transport tags", () => {
  assert.equal(transportTagFor("ecr-public.aws.com/docker/library/redis:8.6.4-alpine"), "agentic-iac-s10/redis-transport:8.6.4");
  assert.equal(transportTagFor("quay.io/argoproj/argocd:v3.5.1"), "agentic-iac-s10/argocd-transport:v3.5.1");
  assert.throws(() => transportTagFor("attacker.invalid/image:latest"), /ARGO_IMAGE_SET_CHANGED/);
});

test("node image comparison accounts for containerd's docker.io prefix", () => {
  assert.equal(normalizeNodeImageReference("309-agentic-iac/inference-platform:s10-v1"), "docker.io/309-agentic-iac/inference-platform:s10-v1");
  assert.equal(normalizeNodeImageReference("quay.io/argoproj/argocd:v3.5.1"), "quay.io/argoproj/argocd:v3.5.1");
});

test("workload readiness uses explicit learner-visible deployments, never rollout --all", () => {
  assert.deepEqual(workloadRolloutTargets(), [
    "inference-platform-api",
    "inference-platform-dependencies",
    "inference-platform-worker",
  ]);
  assert.ok(workloadRolloutTargets().every((name) => !name.startsWith("--")));
});

test("hard wall-clock control kills a child that ignores soft termination", async () => {
  const records = [];
  const started = Date.now();
  const result = await executeWithHardTimeout(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { records, timeout: 100, killGrace: 50, accepted: [0, null] });
  assert.equal(result.timed_out, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started < 1_000);
});

test("epoch deadline expires immediately after a simulated host-suspend clock jump", () => {
  assert.equal(deadlineAction({ now: 1_000, deadline: 2_000, termSentAt: null, killGrace: 500 }), null);
  assert.equal(deadlineAction({ now: 20_000, deadline: 2_000, termSentAt: null, killGrace: 500 }), "SIGTERM");
  assert.equal(deadlineAction({ now: 20_501, deadline: 2_000, termSentAt: 20_000, killGrace: 500 }), "SIGKILL");
});

test("hard wall-clock control kills the real child process group", () => {
  const parentSource = [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
    "process.stdout.write(String(child.pid))",
    "process.on('SIGTERM',()=>{})",
    "setInterval(()=>{},1000)",
  ].join(";");
  const result = executeWithHardTimeout(process.execPath, ["-e", parentSource], { timeout: 100, killGrace: 50, accepted: [null] });
  const grandchildPid = Number(result.stdout);
  assert.equal(result.timed_out, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1);
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
});

test("hard wall-clock control is bundled and works without a timeout binary on caller PATH", () => {
  const original = process.env.PATH;
  process.env.PATH = "/no-timeout-binary";
  try {
    const result = executeWithHardTimeout(process.execPath, ["-e", "process.exit(0)"], { timeout: 500 });
    assert.equal(result.exit, 0);
    assert.equal(result.controller, "bundled-node");
  } finally {
    process.env.PATH = original;
  }
});

test("serialized command evidence redacts runtime Secret bytes", () => {
  const secret = "s10-runtime-token";
  const records = [];
  execute(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(secret)})`, "--", `--from-literal=token=${secret}`], { records, redactions: [secret] });
  assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
  assert.match(JSON.stringify(records), /REDACTED/);
});

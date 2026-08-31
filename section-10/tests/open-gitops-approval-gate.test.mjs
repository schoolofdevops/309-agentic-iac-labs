import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DAEMON_COMMAND } from "../scripts/start-git-mirror.mjs";

import * as opener from "../scripts/open-gitops-approval-gate.mjs";
import {
  APPROVAL_MARKER_BYTES,
  APPROVAL_MARKER_NAME,
  V1_APPROVAL_MESSAGE,
  V1_APPROVAL_TAG,
  assertApprovalBoundaryUnchanged,
  bindApprovalBoundary,
  inspectGitCandidate,
  validateRecoveryPersistence,
  validateRuntimeSnapshot,
} from "../scripts/open-gitops-approval-gate.mjs";

const GIT = "/usr/bin/git";
const VALUES = "section-10/starter/gitops/chart/values.yaml";
const NODE_IMAGE = "kindest/node@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const openerSource = join(dirname(fileURLToPath(import.meta.url)), "../scripts/open-gitops-approval-gate.mjs");

function runOpener({ source, approval, revision, purpose }) {
  return spawnSync(process.execPath, [openerSource,
    "--source", source, "--revision", revision, "--approval", approval, "--purpose", purpose,
  ], { encoding: "utf8" });
}

function git(root, args, env = process.env) {
  const result = spawnSync(GIT, ["-C", root, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function values(tag = "s10-v1") {
  return `replicaCount: 1

image:
  repository: 309-agentic-iac/inference-platform
  tag: ${tag}
  pullPolicy: IfNotPresent

service:
  api:
    type: NodePort
    port: 8080
    nodePort: 30080
  dependencies:
    type: ClusterIP
    port: 8081

backend:
  url: http://inference-platform-dependencies:8081
  existingSecret:
    name: inference-platform-backend-token
    key: token

resources:
  dependencies:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 64Mi
  api:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 64Mi
  worker:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 64Mi

probes:
  readiness:
    initialDelaySeconds: 1
    periodSeconds: 3
    timeoutSeconds: 1
    failureThreshold: 3
  liveness:
    initialDelaySeconds: 2
    periodSeconds: 5
    timeoutSeconds: 1
    failureThreshold: 3

networkPolicy:
  enabled: false
  enforcementNote: Rendered policy is not proof of enforcement; use a policy-capable CNI.
`;
}

function fixture({ candidateBytes = values("s10-v2"), extraCandidate } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-source-"));
  mkdirSync(join(root, dirname(VALUES)), { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "learner@example.test"]);
  git(root, ["config", "user.name", "Learner"]);
  writeFileSync(join(root, VALUES), values());
  git(root, ["add", VALUES]);
  git(root, ["commit", "-q", "-m", "v1"]);
  const v1 = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "-a", V1_APPROVAL_TAG, "-m", V1_APPROVAL_MESSAGE, v1]);
  writeFileSync(join(root, VALUES), candidateBytes);
  if (extraCandidate) extraCandidate(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "v2"]);
  const v2 = git(root, ["rev-parse", "HEAD"]);
  return { root, v1, v2 };
}

function approvalFixture(source, purpose = "promote-v2") {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-human."));
  chmodSync(root, 0o700);
  const approvals = join(root, "approvals");
  mkdirSync(approvals, { mode: 0o700 });
  const marker = join(approvals, APPROVAL_MARKER_NAME);
  writeFileSync(marker, APPROVAL_MARKER_BYTES, { mode: 0o400 });
  chmodSync(marker, 0o400);
  return { approval: join(approvals, purpose === "promote-v2" ? "v2.json" : "recovery.json"), approvals, marker, root, source };
}

function runtimeSnapshot({ currentRevision = "1".repeat(40), imageTag = "s10-v1", images, sync = "Synced", health = "Healthy" } = {}) {
  const serverPort = "53123";
  const source = { repoURL: "git://agentic-iac-s10-git:9418/delivery.git", targetRevision: "HEAD", path: "section-10/starter/gitops/chart" };
  const destination = { server: "https://kubernetes.default.svc", namespace: "inference" };
  return {
    kubeconfig: {
      currentContext: "kind-agentic-iac-s10",
      contexts: [{ name: "kind-agentic-iac-s10", context: { cluster: "kind-agentic-iac-s10", user: "kind-agentic-iac-s10" } }],
      clusters: [{ name: "kind-agentic-iac-s10", cluster: { server: `https://127.0.0.1:${serverPort}` } }],
    },
    nodeContainer: {
      Id: "a".repeat(64), Name: "/agentic-iac-s10-control-plane", State: { Running: true },
      Config: { Image: NODE_IMAGE, Labels: { "io.x-k8s.kind.cluster": "agentic-iac-s10", "io.x-k8s.kind.role": "control-plane" } },
      HostConfig: { PortBindings: { "6443/tcp": [{ HostIp: "127.0.0.1", HostPort: serverPort }] } },
      NetworkSettings: { Networks: { kind: {} } },
    },
    kubeNode: {
      apiVersion: "v1", kind: "Node",
      metadata: { name: "agentic-iac-s10-control-plane", uid: "node-uid", labels: { "kubernetes.io/hostname": "agentic-iac-s10-control-plane", "node-role.kubernetes.io/control-plane": "" } },
      status: { nodeInfo: { kubeletVersion: "v1.36.1" }, conditions: [{ type: "Ready", status: "True" }] },
    },
    owner: {
      apiVersion: "v1", kind: "ConfigMap", metadata: { name: "agentic-iac-s10-lifecycle-owner", namespace: "inference", uid: "owner-uid" },
      data: { application: "inference-platform", cluster: "agentic-iac-s10" },
    },
    application: {
      apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name: "inference-platform", namespace: "argocd", uid: "application-uid" },
      spec: { project: "default", source, destination, syncPolicy: { syncOptions: ["CreateNamespace=false"] } },
      status: {
        sync: { status: sync, revision: currentRevision, comparedTo: { source, destination } },
        health: { status: health }, sourceType: "Helm", summary: { images: images ?? [`309-agentic-iac/inference-platform:${imageTag}`] },
        operationState: { phase: "Succeeded", operation: { initiatedBy: { username: "human-platform-reviewer" }, sync: { revision: currentRevision, syncOptions: ["CreateNamespace=false"] } }, syncResult: { revision: currentRevision } },
        history: [{ revision: currentRevision, initiatedBy: { username: "human-platform-reviewer" } }],
      },
    },
    mirror: {
      Id: "b".repeat(64), Name: "/agentic-iac-s10-git", State: { Running: true },
      Config: { Image: "bitnami/git@sha256:972d6f1ac0e2b62f689794c56620f75d18f22be8f1069554a7622622e5bed548", User: "65534:65534", Cmd: [...DAEMON_COMMAND], Labels: { "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-mirror", "com.schoolofdevops.source-revision": currentRevision } },
      HostConfig: { ReadonlyRootfs: true, NetworkMode: "kind", CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"] },
      Mounts: [{ Destination: "/git/delivery.git", RW: false, Type: "bind" }], NetworkSettings: { Networks: { kind: { IPAddress: "172.18.0.3" } } },
    },
    deployment: {
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "inference-platform-api", namespace: "inference", uid: "deployment-uid", generation: 7 },
      spec: { replicas: 2, template: { spec: { containers: [{ name: "api", image: "309-agentic-iac/inference-platform:stale-missing", imagePullPolicy: "Never" }] } } },
      status: { observedGeneration: 7, replicas: 3, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 1, conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] },
    },
  };
}

test("production opener retains the exact gate binding through foreground approval", () => {
  assert.equal(opener.openLearnerApprovalGate, undefined);
  assert.equal(opener.openGate, undefined);
  const source = readFileSync(openerSource, "utf8");
  assert.doesNotMatch(source, /(?:create|open)LearnerApprovalGate\([^)]*,\s*\{/);
  assert.doesNotMatch(source, /\b(?:kubeRun|openGate|driftObservationMs|sleep)\s*=/);
  assert.match(source, /openApprovalGate\(boundary\.approval, input\.revision, input\.purpose, observed\)/);
  assert.match(source, /assertApprovalBoundaryUnchanged\(boundary, \{ gateExpected: true, gateBinding: gate\.binding \}\)/);
  assert.match(source, /gateBinding: gate\.binding/);
  assert.match(source, /completeInteractiveApproval\(\{[\s\S]*gateBinding: result\.gateBinding/);
  assert.match(source, /JSON\.stringify\(result\.gateBinding\.gate, null, 2\)/);
  assert.doesNotMatch(source, /binding\.json|writeApprovalGateHandoff|assertApprovalGateHandoff|\.sock|startBoundApprovalSession/);
  assert.match(source, /removeOwnedApprovalGate\(gate\.ownership\)/);
});

test("promotion accepts only the frozen v1 to v2 byte transition", () => {
  const value = fixture();
  try {
    const result = inspectGitCandidate({ source: value.root, revision: value.v2, currentRevision: value.v1, purpose: "promote-v2" });
    assert.equal(result.candidate.revision, value.v2);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("promotion requires the exact annotated v1 human approval tag", () => {
  const missing = fixture();
  try {
    git(missing.root, ["tag", "-d", V1_APPROVAL_TAG]);
    assert.throws(() => inspectGitCandidate({ source: missing.root, revision: missing.v2, currentRevision: missing.v1, purpose: "promote-v2" }), /V1_APPROVAL_INVALID/);
  } finally { rmSync(missing.root, { recursive: true, force: true }); }

  const altered = fixture();
  try {
    git(altered.root, ["tag", "-d", V1_APPROVAL_TAG]);
    git(altered.root, ["tag", "-a", V1_APPROVAL_TAG, "-m", "approved_by=agent-author purpose=promote-v1", altered.v1]);
    assert.throws(() => inspectGitCandidate({ source: altered.root, revision: altered.v2, currentRevision: altered.v1, purpose: "promote-v2" }), /V1_APPROVAL_INVALID/);
  } finally { rmSync(altered.root, { recursive: true, force: true }); }
});

test("recovery accepts only the direct exact revert from v2 to v1", () => {
  const value = fixture();
  try {
    git(value.root, ["revert", "--no-edit", value.v2]);
    const recovery = git(value.root, ["rev-parse", "HEAD"]);
    const result = inspectGitCandidate({ source: value.root, revision: recovery, currentRevision: value.v2, purpose: "revert-and-recover" });
    assert.equal(result.candidate.revision, recovery);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("promotion rejects repository, replicas, duplicate tags, extra keys, and unrelated same-file edits", () => {
  const mutations = [
    values("s10-v2").replace("repository: 309-agentic-iac/inference-platform", "repository: attacker.example/foreign"),
    values("s10-v2").replace("replicaCount: 1", "replicaCount: 99"),
    values("s10-v2").replace("  pullPolicy: IfNotPresent", "  tag: s10-v2\n  pullPolicy: IfNotPresent"),
    `${values("s10-v2")}attacker: true\n`,
    values("s10-v2").replace("periodSeconds: 5", "periodSeconds: 30"),
  ];
  for (const candidateBytes of mutations) {
    const value = fixture({ candidateBytes });
    try { assert.throws(() => inspectGitCandidate({ source: value.root, revision: value.v2, currentRevision: value.v1, purpose: "promote-v2" }), /PROMOTION_VALUES_INVALID/); }
    finally { rmSync(value.root, { recursive: true, force: true }); }
  }
});

test("promotion rejects leading whitespace, trailing spaces, and an extra final newline", () => {
  const mutations = [
    ` ${values("s10-v2")}`,
    `${values("s10-v2")} `,
    `${values("s10-v2")}\n`,
  ];
  for (const candidateBytes of mutations) {
    const value = fixture({ candidateBytes });
    try { assert.throws(() => inspectGitCandidate({ source: value.root, revision: value.v2, currentRevision: value.v1, purpose: "promote-v2" }), /PROMOTION_VALUES_INVALID/); }
    finally { rmSync(value.root, { recursive: true, force: true }); }
  }
});

test("promotion rejects an extra committed path", () => {
  const value = fixture({ extraCandidate: (root) => writeFileSync(join(root, "extra.txt"), "broad\n") });
  try { assert.throws(() => inspectGitCandidate({ source: value.root, revision: value.v2, currentRevision: value.v1, purpose: "promote-v2" }), /PROMOTION_SCOPE_INVALID/); }
  finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("minimal Git environment ignores repository selectors inherited from the caller", () => {
  const source = fixture();
  const foreign = fixture();
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = join(foreign.root, ".git");
    process.env.GIT_WORK_TREE = foreign.root;
    process.env.GIT_INDEX_FILE = join(foreign.root, ".git/index");
    process.env.GIT_OBJECT_DIRECTORY = join(foreign.root, ".git/objects");
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(foreign.root, ".git/objects");
    const result = inspectGitCandidate({ source: source.root, revision: source.v2, currentRevision: source.v1, purpose: "promote-v2" });
    assert.equal(result.candidate.revision, source.v2);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(source.root, { recursive: true, force: true });
    rmSync(foreign.root, { recursive: true, force: true });
  }
});

test("approval output is confined to the exact marked temporary approval root", () => {
  const value = fixture();
  const approval = approvalFixture(value.root);
  try {
    const binding = bindApprovalBoundary({ source: value.root, approval: approval.approval, purpose: "promote-v2" });
    assert.equal(binding.approval, approval.approval);
    assertApprovalBoundaryUnchanged(binding, { gateExpected: false });
    assert.throws(() => bindApprovalBoundary({ source: value.root, approval: join(approval.root, "wrong.json"), purpose: "promote-v2" }), /APPROVAL_PATH_FORBIDDEN/);
    assert.throws(() => bindApprovalBoundary({ source: value.root, approval: join(value.root, "v2.json"), purpose: "promote-v2" }), /APPROVAL_PATH_FORBIDDEN/);
  } finally { rmSync(value.root, { recursive: true, force: true }); rmSync(approval.root, { recursive: true, force: true }); }
});

test("approval boundary rejects bad marker modes, preexisting output, and symlink ancestors", () => {
  const value = fixture();
  const badMode = approvalFixture(value.root);
  try {
    chmodSync(badMode.marker, 0o600);
    assert.throws(() => bindApprovalBoundary({ source: value.root, approval: badMode.approval, purpose: "promote-v2" }), /APPROVAL_MARKER_INVALID/);
  } finally { rmSync(badMode.root, { recursive: true, force: true }); }

  const existing = approvalFixture(value.root);
  try {
    writeFileSync(existing.approval, "occupied\n");
    assert.throws(() => bindApprovalBoundary({ source: value.root, approval: existing.approval, purpose: "promote-v2" }), /PREEXISTING_APPROVAL_STATE/);
  } finally { rmSync(existing.root, { recursive: true, force: true }); }

  const real = approvalFixture(value.root);
  const linked = `${real.root}-link`;
  try {
    symlinkSync(real.root, linked, "dir");
    assert.throws(() => bindApprovalBoundary({ source: value.root, approval: join(linked, "approvals/v2.json"), purpose: "promote-v2" }), /(SYMLINK_ANCESTOR_FORBIDDEN|APPROVAL_PATH_FORBIDDEN)/);
  } finally { try { unlinkSync(linked); } catch { /* test cleanup */ } rmSync(real.root, { recursive: true, force: true }); rmSync(value.root, { recursive: true, force: true }); }
});

test("opener CLI rejects final and ancestor lexical source symlinks", () => {
  const value = fixture();
  const approval = approvalFixture(value.root);
  const finalLink = `${value.root}-link`;
  const ancestorLink = `${dirname(value.root)}-ancestor-link`;
  try {
    symlinkSync(value.root, finalLink, "dir");
    symlinkSync(dirname(value.root), ancestorLink, "dir");
    for (const source of [finalLink, join(ancestorLink, value.root.split("/").at(-1))]) {
      const result = runOpener({ source, approval: approval.approval, revision: value.v2, purpose: "promote-v2" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /SYMLINK_ANCESTOR_FORBIDDEN/);
      assert.equal(result.stdout, "");
      assert.equal(lstatSync(`${approval.approval}.gate.json`, { throwIfNoEntry: false }), undefined);
    }
  } finally {
    try { unlinkSync(finalLink); } catch { /* test cleanup */ }
    try { unlinkSync(ancestorLink); } catch { /* test cleanup */ }
    rmSync(approval.root, { recursive: true, force: true });
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("approval boundary detects marker and directory replacement races", () => {
  const value = fixture();
  const markerSwap = approvalFixture(value.root);
  try {
    const binding = bindApprovalBoundary({ source: value.root, approval: markerSwap.approval, purpose: "promote-v2" });
    rmSync(markerSwap.marker);
    writeFileSync(markerSwap.marker, APPROVAL_MARKER_BYTES, { mode: 0o400 });
    assert.throws(() => assertApprovalBoundaryUnchanged(binding, { gateExpected: false }), /APPROVAL_BOUNDARY_CHANGED/);
  } finally { rmSync(markerSwap.root, { recursive: true, force: true }); }

  const directorySwap = approvalFixture(value.root);
  try {
    const binding = bindApprovalBoundary({ source: value.root, approval: directorySwap.approval, purpose: "promote-v2" });
    const moved = `${directorySwap.approvals}-old`;
    assert.equal(spawnSync("mv", [directorySwap.approvals, moved]).status, 0);
    mkdirSync(directorySwap.approvals, { mode: 0o700 });
    writeFileSync(join(directorySwap.approvals, APPROVAL_MARKER_NAME), APPROVAL_MARKER_BYTES, { mode: 0o400 });
    assert.throws(() => assertApprovalBoundaryUnchanged(binding, { gateExpected: false }), /APPROVAL_BOUNDARY_CHANGED/);
  } finally { rmSync(directorySwap.root, { recursive: true, force: true }); rmSync(value.root, { recursive: true, force: true }); }

  const sourceSwap = fixture();
  const sourceApproval = approvalFixture(sourceSwap.root);
  const movedSource = `${sourceSwap.root}-old`;
  try {
    const binding = bindApprovalBoundary({ source: sourceSwap.root, approval: sourceApproval.approval, purpose: "promote-v2" });
    assert.equal(spawnSync("mv", [sourceSwap.root, movedSource]).status, 0);
    mkdirSync(sourceSwap.root);
    assert.throws(() => assertApprovalBoundaryUnchanged(binding, { gateExpected: false }), /SOURCE_BOUNDARY_CHANGED/);
  } finally {
    rmSync(sourceSwap.root, { recursive: true, force: true });
    rmSync(movedSource, { recursive: true, force: true });
    rmSync(sourceApproval.root, { recursive: true, force: true });
  }
});

test("promotion runtime binds exact cluster, mirror, owner, Application, and human operation", () => {
  const currentRevision = "1".repeat(40);
  const result = validateRuntimeSnapshot(runtimeSnapshot({ currentRevision }), { purpose: "promote-v2", currentRevision });
  assert.deepEqual(result.observed, { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: currentRevision });
});

test("runtime rejects foreign Application and operation variants", () => {
  const currentRevision = "1".repeat(40);
  const mutations = [
    (value) => { value.application.spec.project = "foreign"; },
    (value) => { value.application.spec.destination.server = "https://foreign"; },
    (value) => { value.application.spec.destination.namespace = "foreign"; },
    (value) => { value.application.spec.syncPolicy.syncOptions = ["CreateNamespace=true"]; },
    (value) => { value.application.status.operationState.operation.initiatedBy.username = "agent-author"; },
    (value) => { value.application.status.operationState.operation.sync.revision = "9".repeat(40); },
    (value) => { value.application.status.operationState.syncResult.revision = "9".repeat(40); },
    (value) => { value.application.status.history[0].initiatedBy.username = "agent-author"; },
  ];
  for (const mutate of mutations) {
    const snapshot = runtimeSnapshot({ currentRevision }); mutate(snapshot);
    assert.throws(() => validateRuntimeSnapshot(snapshot, { purpose: "promote-v2", currentRevision }), /APPLICATION_(CONTRACT|OPERATION)_INVALID/);
  }
});

test("runtime rejects foreign kubeconfig endpoint, node, owner, and mirror evidence", () => {
  const currentRevision = "1".repeat(40);
  const mutations = [
    (value) => { value.kubeconfig.clusters[0].cluster.server = "https://127.0.0.1:6443"; },
    (value) => { value.nodeContainer.Config.Image = "kindest/node:latest"; },
    (value) => { value.kubeNode.status.conditions[0].status = "False"; },
    (value) => { value.owner.data.cluster = "foreign"; },
    (value) => { value.mirror.Config.Labels["com.schoolofdevops.source-revision"] = "9".repeat(40); },
    (value) => { value.mirror.HostConfig.ReadonlyRootfs = false; },
  ];
  for (const mutate of mutations) {
    const snapshot = runtimeSnapshot({ currentRevision }); mutate(snapshot);
    assert.throws(() => validateRuntimeSnapshot(snapshot, { purpose: "promote-v2", currentRevision }), /(KUBECONFIG|KIND_NODE|COURSE_OWNER|MIRROR)_INVALID/);
  }
});

test("recovery requires degraded OutOfSync and two current ready replicas", () => {
  const currentRevision = "2".repeat(40);
  const images = ["309-agentic-iac/inference-platform:s10-v2", "309-agentic-iac/inference-platform:stale-missing"];
  const accepted = runtimeSnapshot({ currentRevision, images, sync: "OutOfSync", health: "Degraded" });
  const result = validateRuntimeSnapshot(accepted, { purpose: "revert-and-recover", currentRevision });
  assert.equal(result.deployment.readyReplicas, 2);
  const mutations = [
    (value) => { value.deployment.status.readyReplicas = 0; },
    (value) => { value.deployment.status.availableReplicas = 1; },
    (value) => { value.deployment.status.observedGeneration = 6; },
    (value) => { value.deployment.spec.template.spec.containers[0].image = "309-agentic-iac/inference-platform:s10-v2"; },
    (value) => { value.deployment.spec.template.spec.containers[0].imagePullPolicy = "IfNotPresent"; },
    (value) => { value.deployment.status.conditions[0].reason = "ReplicaSetUpdated"; },
  ];
  for (const mutate of mutations) {
    const snapshot = runtimeSnapshot({ currentRevision, images, sync: "OutOfSync", health: "Degraded" }); mutate(snapshot);
    assert.throws(() => validateRuntimeSnapshot(snapshot, { purpose: "revert-and-recover", currentRevision }), /DRIFT_EVIDENCE_INVALID/);
  }
});

test("recovery rejects an Application summary outside the exact current and staged images", () => {
  const currentRevision = "2".repeat(40);
  for (const images of [
    ["309-agentic-iac/inference-platform:s10-v2"],
    ["309-agentic-iac/inference-platform:s10-v2", "foreign.example/image:latest"],
    ["309-agentic-iac/inference-platform:s10-v2", "309-agentic-iac/inference-platform:stale-missing", "foreign.example/image:latest"],
  ]) {
    const snapshot = runtimeSnapshot({ currentRevision, images, sync: "OutOfSync", health: "Degraded" });
    assert.throws(() => validateRuntimeSnapshot(snapshot, { purpose: "revert-and-recover", currentRevision }), /APPLICATION_CONTRACT_INVALID/);
  }
});

test("recovery persistence rejects replacement, generation change, lost readiness, or self-heal", () => {
  const currentRevision = "2".repeat(40);
  const images = ["309-agentic-iac/inference-platform:s10-v2", "309-agentic-iac/inference-platform:stale-missing"];
  const before = runtimeSnapshot({ currentRevision, images, sync: "OutOfSync", health: "Degraded" });
  assert.deepEqual(validateRecoveryPersistence(before, structuredClone(before), currentRevision), { sync: "OutOfSync", replicas_after_15_seconds: 2 });
  const mutations = [
    (value) => { value.deployment.metadata.uid = "replacement"; },
    (value) => { value.deployment.metadata.generation = 8; value.deployment.status.observedGeneration = 8; },
    (value) => { value.deployment.status.readyReplicas = 1; },
    (value) => { value.application.status.sync.status = "Synced"; },
  ];
  for (const mutate of mutations) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => validateRecoveryPersistence(before, after, currentRevision), /(DRIFT_DID_NOT_PERSIST|RUNTIME_IDENTITY_CHANGED)/);
  }
});

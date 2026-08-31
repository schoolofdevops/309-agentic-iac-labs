#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  APPROVAL_GATE_HANDOFF_SUFFIX,
  EXACT,
  assertApprovalGateBinding,
  assertApprovalGateHandoff,
  openApprovalGate,
  removeOwnedApprovalGate,
  removeOwnedApprovalGateHandoff,
  writeApprovalGateHandoff,
} from "./run-gitops-lifecycle.mjs";
import { DAEMON_COMMAND, IMAGE as GIT_IMAGE, productionRuntime } from "./start-git-mirror.mjs";

const PROMOTION_PATH = "section-10/starter/gitops/chart/values.yaml";
const KIND_IMAGE = "kindest/node@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
export const V1_APPROVAL_TAG = "section-10-reviewed-v1";
export const V1_APPROVAL_MESSAGE = "approved_by=human-platform-reviewer purpose=promote-v1";
export const APPROVAL_MARKER_NAME = ".agentic-iac-s10-approval-root";
export const APPROVAL_MARKER_BYTES = "agentic-iac-s10-approval-root-v1\n";
const FROZEN_V1_VALUES = `replicaCount: 1

image:
  repository: 309-agentic-iac/inference-platform
  tag: s10-v1
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
const FROZEN_V2_VALUES = FROZEN_V1_VALUES.replace("  tag: s10-v1\n", "  tag: s10-v2\n");
function gitBlobId(bytes) {
  const body = Buffer.from(bytes, "utf8");
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}
const FROZEN_V1_BLOB = gitBlobId(FROZEN_V1_VALUES);
const FROZEN_V2_BLOB = gitBlobId(FROZEN_V2_VALUES);
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
  "-c", "diff.external=", "-c", "protocol.file.allow=always",
];
const PURPOSES = new Set(["promote-v2", "revert-and-recover"]);

function fail(code, detail = "") { throw new Error(`${code}${detail ? `: ${detail}` : ""}`); }
function isRevision(value) { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }

function trustedTool(name) {
  const candidates = name === "git"
    ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    : ["/opt/homebrew/bin/kubectl", "/usr/local/bin/kubectl", "/usr/bin/kubectl"];
  const currentUid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const executable = realpathSync(candidate);
    const metadata = statSync(executable);
    if (metadata.isFile() && (metadata.mode & 0o111) !== 0 && (metadata.mode & 0o022) === 0 && [0, currentUid].includes(metadata.uid)) return executable;
  }
  fail("TRUSTED_TOOL_MISSING", name);
}

function bindTrustedTool(name) {
  const path = trustedTool(name);
  const binding = protectedFile(path, statSync(path).mode & 0o777, "TRUSTED_TOOL_CHANGED");
  const version = name === "git"
    ? command(binding.canonical, ["--version"])
    : command(binding.canonical, ["version", "--client=true", "-o", "json"]);
  let kubectlVersion;
  if (name === "kubectl") {
    try { kubectlVersion = JSON.parse(version)?.clientVersion?.gitVersion; } catch { fail("TRUSTED_TOOL_VERSION_INVALID", name); }
  }
  if ((name === "git" && !/^git version 2\.[0-9]+\.[0-9]+(?: \(Apple Git-[0-9.]+\))?$/.test(version))
    || (name === "kubectl" && kubectlVersion !== "v1.36.2")) fail("TRUSTED_TOOL_VERSION_INVALID", name);
  return { ...binding, name };
}

function assertToolUnchanged(binding) {
  assertProtectedFileUnchanged(binding, "TRUSTED_TOOL_CHANGED");
}

function command(executable, args, { cwd, env = {}, accepted = [0], timeout = 30_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout,
    env: { HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PAGER: "cat", PATH: "/usr/bin:/bin", ...env },
  });
  if (!accepted.includes(result.status)) fail("EVIDENCE_COMMAND_FAILED", result.stderr.trim() || result.stdout.trim() || `${executable} exited ${result.status}`);
  return result.stdout.trim();
}

function productionGit(source, args) {
  return command(trustedTool("git"), ["-C", source, ...SAFE_GIT_CONFIG, ...args], {
    env: {
      GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXTERNAL_DIFF: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat", GIT_PROTOCOL_FROM_USER: "0", GIT_SSH_COMMAND: "/usr/bin/false", GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function boundGit(binding, source, args) {
  assertToolUnchanged(binding);
  const output = command(binding.canonical, ["-C", source, ...SAFE_GIT_CONFIG, ...args], {
    env: {
      GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXTERNAL_DIFF: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat", GIT_PROTOCOL_FROM_USER: "0", GIT_SSH_COMMAND: "/usr/bin/false", GIT_TERMINAL_PROMPT: "0",
    },
  });
  assertToolUnchanged(binding);
  return output;
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function pathAncestors(path) {
  const values = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    values.unshift(current);
    if (current === dirname(current)) return values;
  }
}

function allowedSystemAlias(path, canonical) {
  return ({ "/tmp": "/private/tmp", "/var": "/private/var" })[path] === canonical;
}

function rejectSymlinkAncestors(path) {
  for (const ancestor of pathAncestors(path)) {
    if (!existsSync(ancestor)) continue;
    const metadata = lstatSync(ancestor);
    if (metadata.isSymbolicLink() && !allowedSystemAlias(ancestor, realpathSync(ancestor))) fail("SYMLINK_ANCESTOR_FORBIDDEN", ancestor);
  }
}

function identity(path, expected) {
  rejectSymlinkAncestors(path);
  const canonical = realpathSync(path);
  const metadata = lstatSync(canonical);
  if ((expected === "directory" && !metadata.isDirectory()) || (expected === "file" && !metadata.isFile()) || metadata.isSymbolicLink()) fail("PATH_IDENTITY_INVALID", path);
  return { canonical, device: String(metadata.dev), inode: String(metadata.ino), mode: metadata.mode & 0o777, owner: String(metadata.uid), size: metadata.size };
}

function sameIdentity(left, right, includeSize = false) {
  return left.canonical === right.canonical && left.device === right.device && left.inode === right.inode
    && left.mode === right.mode && left.owner === right.owner && (!includeSize || left.size === right.size);
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function protectedFile(path, expectedMode, code) {
  let binding;
  try { binding = identity(path, "file"); } catch { fail(code); }
  const owner = String(typeof process.getuid === "function" ? process.getuid() : userInfo().uid);
  if (binding.mode !== expectedMode || !["0", owner].includes(binding.owner)) fail(code);
  return { ...binding, digest: fileDigest(binding.canonical) };
}

function assertProtectedFileUnchanged(binding, code) {
  let current;
  try { current = protectedFile(binding.canonical, binding.mode, code); } catch { fail(code); }
  if (!sameIdentity(binding, current, true) || binding.digest !== current.digest) fail(code);
}

function isSystemTemporaryRoot(path) {
  const roots = [realpathSync("/tmp")];
  if (existsSync("/private/var/folders")) roots.push(realpathSync("/private/var/folders"));
  return roots.some((root) => isWithin(root, path));
}

export function bindApprovalBoundary({ source: sourceInput, approval: approvalInput, purpose }) {
  if (!PURPOSES.has(purpose)) fail("INPUT_INVALID");
  const lexicalSource = resolve(sourceInput);
  rejectSymlinkAncestors(lexicalSource);
  const source = realpathSync(lexicalSource);
  const sourceIdentity = identity(source, "directory");
  const approval = resolve(approvalInput);
  const expectedName = purpose === "promote-v2" ? "v2.json" : "recovery.json";
  const approvalRootPath = dirname(approval);
  const temporaryRootPath = dirname(approvalRootPath);
  if (approval !== resolve(approvalRootPath, expectedName) || dirname(approvalRootPath) === approvalRootPath
    || approvalRootPath.split(sep).at(-1) !== "approvals" || !/^agentic-iac-s10-human\.[A-Za-z0-9]+$/.test(temporaryRootPath.split(sep).at(-1) ?? "")) fail("APPROVAL_PATH_FORBIDDEN");
  rejectSymlinkAncestors(approval);
  const temporaryRoot = identity(temporaryRootPath, "directory");
  const approvalRoot = identity(approvalRootPath, "directory");
  if (!isSystemTemporaryRoot(temporaryRoot.canonical) || temporaryRoot.mode !== 0o700 || approvalRoot.mode !== 0o700
    || temporaryRoot.owner !== String(typeof process.getuid === "function" ? process.getuid() : userInfo().uid)
    || approvalRoot.owner !== temporaryRoot.owner || isWithin(source, temporaryRoot.canonical) || isWithin(temporaryRoot.canonical, source)) fail("APPROVAL_PATH_FORBIDDEN");
  const markerPath = resolve(approvalRootPath, APPROVAL_MARKER_NAME);
  let marker;
  try { marker = identity(markerPath, "file"); } catch { fail("APPROVAL_MARKER_INVALID"); }
  if (marker.mode !== 0o400 || marker.owner !== approvalRoot.owner || marker.size !== Buffer.byteLength(APPROVAL_MARKER_BYTES)
    || readFileSync(marker.canonical, "utf8") !== APPROVAL_MARKER_BYTES) fail("APPROVAL_MARKER_INVALID");
  if (existsSync(approval) || existsSync(`${approval}.gate.json`) || existsSync(`${approval}.gate.json${APPROVAL_GATE_HANDOFF_SUFFIX}`)) fail("PREEXISTING_APPROVAL_STATE");
  return { approval, approvalRoot, marker, source, sourceIdentity, temporaryRoot };
}

export function assertApprovalBoundaryUnchanged(binding, { gateExpected, gateBinding }) {
  let currentRoot;
  let currentApprovalRoot;
  let currentMarker;
  try {
    currentRoot = identity(binding.temporaryRoot.canonical, "directory");
    currentApprovalRoot = identity(binding.approvalRoot.canonical, "directory");
    currentMarker = identity(binding.marker.canonical, "file");
  } catch { fail("APPROVAL_BOUNDARY_CHANGED"); }
  if (!sameIdentity(binding.temporaryRoot, currentRoot) || !sameIdentity(binding.approvalRoot, currentApprovalRoot)
    || !sameIdentity(binding.marker, currentMarker, true) || readFileSync(currentMarker.canonical, "utf8") !== APPROVAL_MARKER_BYTES
    || existsSync(binding.approval)) fail("APPROVAL_BOUNDARY_CHANGED");
  let currentSource;
  try { currentSource = identity(binding.source, "directory"); } catch { fail("SOURCE_BOUNDARY_CHANGED"); }
  if (!sameIdentity(binding.sourceIdentity, currentSource)) fail("SOURCE_BOUNDARY_CHANGED");
  const gatePath = `${binding.approval}.gate.json`;
  if (gateExpected) {
    if (!gateBinding || gateBinding.path !== gatePath) fail("APPROVAL_BOUNDARY_CHANGED");
    try { assertApprovalGateBinding(gateBinding); } catch { fail("APPROVAL_BOUNDARY_CHANGED"); }
    if (gateBinding.file.mode !== 0o600 || gateBinding.file.owner !== binding.approvalRoot.owner) fail("APPROVAL_BOUNDARY_CHANGED");
  } else if (existsSync(gatePath)) fail("APPROVAL_BOUNDARY_CHANGED");
}

function exactArray(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
function exactKeys(value, keys) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && exactArray(Object.keys(value).sort(), [...keys].sort());
}
function one(values, predicate) {
  const matches = Array.isArray(values) ? values.filter(predicate) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

function validateCluster(snapshot) {
  const node = snapshot.nodeContainer;
  const binding = node?.HostConfig?.PortBindings?.["6443/tcp"];
  const port = Array.isArray(binding) && binding.length === 1 ? binding[0] : undefined;
  if (!/^[0-9a-f]{64}$/.test(node?.Id ?? "") || node?.Name !== `/${EXACT.node}` || node?.State?.Running !== true
    || node?.Config?.Image !== KIND_IMAGE || node?.Config?.Labels?.["io.x-k8s.kind.cluster"] !== EXACT.cluster
    || node?.Config?.Labels?.["io.x-k8s.kind.role"] !== "control-plane" || !exactArray(Object.keys(node?.NetworkSettings?.Networks ?? {}), ["kind"])
    || port?.HostIp !== "127.0.0.1" || !/^[1-9][0-9]{3,4}$/.test(port?.HostPort ?? "")) fail("KIND_NODE_INVALID");

  const config = snapshot.kubeconfig;
  const context = one(config?.contexts, (item) => item?.name === EXACT.context);
  const cluster = one(config?.clusters, (item) => item?.name === EXACT.context);
  if (config?.currentContext !== EXACT.context || context?.context?.cluster !== EXACT.context || context?.context?.user !== EXACT.context
    || cluster?.cluster?.server !== `https://127.0.0.1:${port.HostPort}`) fail("KUBECONFIG_INVALID");

  const kubeNode = snapshot.kubeNode;
  const ready = one(kubeNode?.status?.conditions, (item) => item?.type === "Ready");
  if (kubeNode?.apiVersion !== "v1" || kubeNode?.kind !== "Node" || kubeNode?.metadata?.name !== EXACT.node
    || typeof kubeNode?.metadata?.uid !== "string" || kubeNode.metadata.uid.length === 0
    || kubeNode?.metadata?.labels?.["kubernetes.io/hostname"] !== EXACT.node
    || !Object.hasOwn(kubeNode?.metadata?.labels ?? {}, "node-role.kubernetes.io/control-plane")
    || kubeNode?.status?.nodeInfo?.kubeletVersion !== "v1.36.1" || ready?.status !== "True") fail("KIND_NODE_INVALID");
}

function validateCourseOwner(owner) {
  if (owner?.apiVersion !== "v1" || owner?.kind !== "ConfigMap" || owner?.metadata?.name !== "agentic-iac-s10-lifecycle-owner"
    || owner?.metadata?.namespace !== EXACT.workloadNamespace || typeof owner?.metadata?.uid !== "string" || owner.metadata.uid.length === 0
    || !exactKeys(owner?.data, ["application", "cluster"]) || owner.data.application !== EXACT.application || owner.data.cluster !== EXACT.cluster) fail("COURSE_OWNER_INVALID");
}

function validateMirror(mirror, currentRevision) {
  const labels = mirror?.Config?.Labels ?? {};
  const mount = Array.isArray(mirror?.Mounts) && mirror.Mounts.length === 1 ? mirror.Mounts[0] : undefined;
  if (!/^[0-9a-f]{64}$/.test(mirror?.Id ?? "") || mirror?.Name !== `/${EXACT.gitContainer}` || mirror?.State?.Running !== true
    || mirror?.Config?.Image !== GIT_IMAGE || mirror?.Config?.User !== "65534:65534" || !exactArray(mirror?.Config?.Cmd, DAEMON_COMMAND)
    || labels["com.schoolofdevops.course"] !== "agentic-iac-s10" || labels["com.schoolofdevops.fixture"] !== "git-mirror"
    || labels["com.schoolofdevops.source-revision"] !== currentRevision || mirror?.HostConfig?.ReadonlyRootfs !== true
    || mirror?.HostConfig?.NetworkMode !== "kind" || !exactArray(mirror?.HostConfig?.CapDrop, ["ALL"])
    || !(mirror?.HostConfig?.CapAdd == null || exactArray(mirror.HostConfig.CapAdd, []))
    || !exactArray(mirror?.HostConfig?.SecurityOpt, ["no-new-privileges"])
    || mount?.Type !== "bind" || mount?.Destination !== "/git/delivery.git" || mount?.RW !== false
    || !exactArray(Object.keys(mirror?.NetworkSettings?.Networks ?? {}), ["kind"]) || !(mirror.NetworkSettings.Networks.kind?.IPAddress?.length > 0)) fail("MIRROR_INVALID");
}

function validateApplication(application, { currentRevision, purpose }) {
  const exactSource = { repoURL: `git://${EXACT.gitContainer}:9418/delivery.git`, targetRevision: "HEAD", path: "section-10/starter/gitops/chart" };
  const exactDestination = { server: "https://kubernetes.default.svc", namespace: EXACT.workloadNamespace };
  const sourceMatches = (value) => exactKeys(value, Object.keys(exactSource))
    && Object.entries(exactSource).every(([key, expected]) => value[key] === expected);
  const destinationMatches = (value) => exactKeys(value, Object.keys(exactDestination))
    && Object.entries(exactDestination).every(([key, expected]) => value[key] === expected);
  const spec = application?.spec;
  const sync = application?.status?.sync;
  if (application?.apiVersion !== "argoproj.io/v1alpha1" || application?.kind !== "Application"
    || application?.metadata?.name !== EXACT.application || application?.metadata?.namespace !== EXACT.argocdNamespace
    || typeof application?.metadata?.uid !== "string" || application.metadata.uid.length === 0
    || !exactKeys(spec, ["destination", "project", "source", "syncPolicy"]) || spec.project !== "default"
    || !sourceMatches(spec.source) || !destinationMatches(spec.destination)
    || !exactKeys(spec.syncPolicy, ["syncOptions"]) || !exactArray(spec.syncPolicy.syncOptions, ["CreateNamespace=false"])
    || sync?.revision !== currentRevision || !sourceMatches(sync?.comparedTo?.source)
    || !destinationMatches(sync?.comparedTo?.destination)
    || application?.status?.sourceType !== "Helm") fail("APPLICATION_CONTRACT_INVALID");
  const operation = application.status?.operationState;
  const latest = Array.isArray(application.status?.history) ? application.status.history.at(-1) : undefined;
  if (operation?.phase !== "Succeeded" || operation?.operation?.initiatedBy?.username !== "human-platform-reviewer"
    || operation?.operation?.sync?.revision !== currentRevision || !exactArray(operation?.operation?.sync?.syncOptions, ["CreateNamespace=false"])
    || ![undefined, false].includes(operation?.operation?.sync?.prune) || operation?.syncResult?.revision !== currentRevision
    || latest?.revision !== currentRevision || latest?.initiatedBy?.username !== "human-platform-reviewer") fail("APPLICATION_OPERATION_INVALID");
  const expectedImages = purpose === "promote-v2"
    ? ["309-agentic-iac/inference-platform:s10-v1"]
    : ["309-agentic-iac/inference-platform:s10-v2", "309-agentic-iac/inference-platform:stale-missing"];
  if (!exactArray(application.status?.summary?.images, expectedImages)) fail("APPLICATION_CONTRACT_INVALID");
}

function validateDeployment(deployment) {
  const container = one(deployment?.spec?.template?.spec?.containers, (item) => item?.name === "api");
  const progress = one(deployment?.status?.conditions, (item) => item?.type === "Progressing");
  if (deployment?.apiVersion !== "apps/v1" || deployment?.kind !== "Deployment" || deployment?.metadata?.name !== "inference-platform-api"
    || deployment?.metadata?.namespace !== EXACT.workloadNamespace || typeof deployment?.metadata?.uid !== "string" || deployment.metadata.uid.length === 0
    || !Number.isInteger(deployment?.metadata?.generation) || deployment.spec?.replicas !== 2
    || deployment.status?.observedGeneration !== deployment.metadata.generation || deployment.status?.readyReplicas !== 2
    || deployment.status?.availableReplicas !== 2 || !(deployment.status?.replicas >= 2) || !(deployment.status?.updatedReplicas >= 1)
    || container?.image !== "309-agentic-iac/inference-platform:stale-missing" || container?.imagePullPolicy !== "Never"
    || progress?.status !== "False" || progress?.reason !== "ProgressDeadlineExceeded") fail("DRIFT_EVIDENCE_INVALID");
  return { availableReplicas: 2, generation: deployment.metadata.generation, readyReplicas: 2, uid: deployment.metadata.uid };
}

export function validateRuntimeSnapshot(snapshot, { purpose, currentRevision }) {
  if (!PURPOSES.has(purpose) || !isRevision(currentRevision)) fail("INPUT_INVALID");
  validateCluster(snapshot);
  validateCourseOwner(snapshot.owner);
  validateMirror(snapshot.mirror, currentRevision);
  validateApplication(snapshot.application, { currentRevision, purpose });
  if (purpose === "promote-v2") {
    if (snapshot.application.status.sync.status !== "Synced" || snapshot.application.status.health?.status !== "Healthy") fail("PROMOTION_STATE_INVALID");
    return { identities: { application: snapshot.application.metadata.uid, mirror: snapshot.mirror.Id, node: snapshot.nodeContainer.Id, owner: snapshot.owner.metadata.uid }, observed: { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: currentRevision } };
  }
  if (snapshot.application.status.sync.status !== "OutOfSync" || snapshot.application.status.health?.status !== "Degraded") fail("RECOVERY_STATE_INVALID");
  return { deployment: validateDeployment(snapshot.deployment), identities: { application: snapshot.application.metadata.uid, deployment: snapshot.deployment.metadata.uid, mirror: snapshot.mirror.Id, node: snapshot.nodeContainer.Id, owner: snapshot.owner.metadata.uid } };
}

export function validateRecoveryPersistence(before, after, currentRevision) {
  const first = validateRuntimeSnapshot(before, { purpose: "revert-and-recover", currentRevision });
  let second;
  try { second = validateRuntimeSnapshot(after, { purpose: "revert-and-recover", currentRevision }); }
  catch (error) { fail("DRIFT_DID_NOT_PERSIST", error.message); }
  if (JSON.stringify(first.identities) !== JSON.stringify(second.identities)
    || first.deployment.generation !== second.deployment.generation || first.deployment.uid !== second.deployment.uid) fail("RUNTIME_IDENTITY_CHANGED");
  return { sync: "OutOfSync", replicas_after_15_seconds: second.deployment.readyReplicas };
}

function repositoryIdentity(source, gitRun) {
  const top = realpathSync(gitRun(source, ["rev-parse", "--show-toplevel"]));
  if (top !== source) fail("SOURCE_NOT_TOPLEVEL");
  const rawGitDirectory = gitRun(source, ["rev-parse", "--git-dir"]);
  const gitDirectory = realpathSync(resolve(source, rawGitDirectory));
  if (!isWithin(source, gitDirectory) || dirname(gitDirectory) !== source || !lstatSync(gitDirectory).isDirectory()) fail("GIT_DIRECTORY_INVALID");
  return { gitDirectory, source };
}

function assertV1Approval(source, revision, gitRun) {
  let type;
  try { type = gitRun(source, ["cat-file", "-t", `refs/tags/${V1_APPROVAL_TAG}`]); }
  catch { fail("V1_APPROVAL_INVALID"); }
  if (type !== "tag") fail("V1_APPROVAL_INVALID");
  const raw = gitRun(source, ["cat-file", "tag", `refs/tags/${V1_APPROVAL_TAG}`]);
  const [headers, message = ""] = raw.split("\n\n", 2);
  const object = headers.split("\n").find((line) => line.startsWith("object "))?.slice(7);
  const declaredType = headers.split("\n").find((line) => line.startsWith("type "))?.slice(5);
  const tag = headers.split("\n").find((line) => line.startsWith("tag "))?.slice(4);
  if (object !== revision || declaredType !== "commit" || tag !== V1_APPROVAL_TAG || message !== V1_APPROVAL_MESSAGE) fail("V1_APPROVAL_INVALID");
}

export function inspectGitCandidate({ source: sourceInput, revision, currentRevision, purpose }, { gitRun = productionGit } = {}) {
  if (!PURPOSES.has(purpose) || !isRevision(revision) || !isRevision(currentRevision)) fail("INPUT_INVALID");
  const requested = resolve(sourceInput);
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink() || !lstatSync(requested).isDirectory()) fail("SOURCE_INVALID");
  const source = realpathSync(requested);
  repositoryIdentity(source, gitRun);
  assertCleanSource(source, gitRun);
  if (gitRun(source, ["rev-parse", "HEAD"]) !== revision) fail("REVISION_NOT_HEAD");
  const candidate = commitRecord(source, revision, gitRun);
  const current = commitRecord(source, currentRevision, gitRun);
  if (purpose === "promote-v2") {
    assertV1Approval(source, currentRevision, gitRun);
    assertPromotionCommit(source, candidate, currentRevision, gitRun);
  } else {
    assertRecoveryCommit(source, candidate, currentRevision, gitRun);
  }
  assertCleanSource(source, gitRun);
  if (gitRun(source, ["rev-parse", "HEAD"]) !== revision) fail("REVISION_CHANGED");
  return { candidate, current, source };
}

function bindKubeconfig() {
  const path = resolve(userInfo().homedir, ".kube", "config");
  const binding = protectedFile(path, 0o600, "KUBECONFIG_INVALID");
  const owner = String(typeof process.getuid === "function" ? process.getuid() : userInfo().uid);
  if (binding.owner !== owner) fail("KUBECONFIG_INVALID");
  return binding;
}

function productionKube(tool, kubeconfig, args) {
  assertToolUnchanged(tool);
  assertProtectedFileUnchanged(kubeconfig, "KUBECONFIG_CHANGED");
  const output = command(tool.canonical, ["--kubeconfig", kubeconfig.canonical, "--context", EXACT.context, ...args], { timeout: 30_000 });
  assertToolUnchanged(tool);
  assertProtectedFileUnchanged(kubeconfig, "KUBECONFIG_CHANGED");
  return output;
}

function parsedObject(raw, code) {
  let value;
  try { value = JSON.parse(raw); } catch { fail(code); }
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function inspectedContainer(runtime, name) {
  const result = runtime.docker(["container", "inspect", name]);
  let values;
  try { values = JSON.parse(result.stdout); } catch { fail("DOCKER_EVIDENCE_INVALID", name); }
  if (!Array.isArray(values) || values.length !== 1) fail("DOCKER_EVIDENCE_INVALID", name);
  return values[0];
}

function collectRuntimeSnapshot(environment, purpose) {
  const kube = (args) => parsedObject(productionKube(environment.kubectl, environment.kubeconfig, args), "KUBERNETES_EVIDENCE_INVALID");
  const rawKubeconfig = kube(["config", "view", "--raw", "-o", "json"]);
  const snapshot = {
    kubeconfig: { ...rawKubeconfig, currentContext: rawKubeconfig["current-context"] },
    nodeContainer: inspectedContainer(environment.runtime, EXACT.node),
    kubeNode: kube(["get", "node", EXACT.node, "-o", "json"]),
    owner: kube(["-n", EXACT.workloadNamespace, "get", "configmap", "agentic-iac-s10-lifecycle-owner", "-o", "json"]),
    application: kube(["-n", EXACT.argocdNamespace, "get", "application", EXACT.application, "-o", "json"]),
    mirror: inspectedContainer(environment.runtime, EXACT.gitContainer),
  };
  if (purpose === "revert-and-recover") {
    snapshot.deployment = kube(["-n", EXACT.workloadNamespace, "get", "deployment", "inference-platform-api", "-o", "json"]);
  }
  return snapshot;
}

function bindProductionEnvironment() {
  const git = bindTrustedTool("git");
  const kubectl = bindTrustedTool("kubectl");
  const kubeconfig = bindKubeconfig();
  return { git, gitRun: (source, args) => boundGit(git, source, args), kubeconfig, kubectl, runtime: productionRuntime() };
}

function assertProductionEnvironmentUnchanged(environment) {
  assertToolUnchanged(environment.git);
  assertToolUnchanged(environment.kubectl);
  assertProtectedFileUnchanged(environment.kubeconfig, "KUBECONFIG_CHANGED");
}

function parseArgs(argv) {
  const allowed = ["--source", "--revision", "--approval", "--purpose"];
  const values = {};
  if (argv.length !== allowed.length * 2) fail("USAGE");
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key) || typeof value !== "string" || value.startsWith("--") || Object.hasOwn(values, key)) fail("USAGE");
    values[key] = value;
  }
  if (allowed.some((key) => !Object.hasOwn(values, key))) fail("USAGE");
  return { source: values["--source"], revision: values["--revision"], approval: values["--approval"], purpose: values["--purpose"] };
}

function commitRecord(source, revision, gitRun) {
  if (!isRevision(revision) || gitRun(source, ["cat-file", "-t", revision]) !== "commit") fail("REVISION_INVALID", revision);
  const raw = gitRun(source, ["cat-file", "commit", revision]);
  const headers = raw.split("\n\n", 1)[0].split("\n");
  const tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (!isRevision(tree) || parents.some((parent) => !isRevision(parent))) fail("COMMIT_OBJECT_INVALID", revision);
  return { revision, tree, parents };
}

function assertCleanSource(source, gitRun) {
  const status = gitRun(source, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") fail("DELIVERY_REPOSITORY_DIRTY", status);
}

function assertPromotionCommit(source, candidate, currentRevision, gitRun) {
  if (candidate.parents.length !== 1 || candidate.parents[0] !== currentRevision) fail("PROMOTION_NOT_DIRECT_SUCCESSOR");
  const current = commitRecord(source, currentRevision, gitRun);
  if (candidate.tree === current.tree) fail("PROMOTION_TREE_UNCHANGED");
  const paths = gitRun(source, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", `${currentRevision}..${candidate.revision}`, "--"])
    .split("\n").filter(Boolean);
  if (JSON.stringify(paths) !== JSON.stringify([PROMOTION_PATH])) fail("PROMOTION_SCOPE_INVALID", paths.join(","));
  const before = gitRun(source, ["rev-parse", `${currentRevision}:${PROMOTION_PATH}`]);
  const after = gitRun(source, ["rev-parse", `${candidate.revision}:${PROMOTION_PATH}`]);
  if (before !== FROZEN_V1_BLOB || after !== FROZEN_V2_BLOB) fail("PROMOTION_VALUES_INVALID");
}

function assertRecoveryCommit(source, recovery, currentRevision, gitRun) {
  if (recovery.parents.length !== 1 || recovery.parents[0] !== currentRevision) fail("RECOVERY_NOT_DIRECT_SUCCESSOR");
  const current = commitRecord(source, currentRevision, gitRun);
  if (current.parents.length !== 1) fail("RECOVERY_LINEAGE_INVALID");
  const previous = commitRecord(source, current.parents[0], gitRun);
  if (recovery.tree !== previous.tree || recovery.tree === current.tree) fail("RECOVERY_TREE_MISMATCH");
  const paths = gitRun(source, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", `${currentRevision}..${recovery.revision}`, "--"])
    .split("\n").filter(Boolean);
  if (JSON.stringify(paths) !== JSON.stringify([PROMOTION_PATH])) fail("RECOVERY_SCOPE_INVALID", paths.join(","));
  const before = gitRun(source, ["rev-parse", `${currentRevision}:${PROMOTION_PATH}`]);
  const after = gitRun(source, ["rev-parse", `${recovery.revision}:${PROMOTION_PATH}`]);
  if (before !== FROZEN_V2_BLOB || after !== FROZEN_V1_BLOB) fail("RECOVERY_VALUES_INVALID");
}

function assertStableValidatedRuntime(first, next, purpose, currentRevision) {
  if (purpose === "revert-and-recover") return validateRecoveryPersistence(first, next, currentRevision);
  const firstResult = validateRuntimeSnapshot(first, { purpose, currentRevision });
  const nextResult = validateRuntimeSnapshot(next, { purpose, currentRevision });
  if (JSON.stringify(firstResult.identities) !== JSON.stringify(nextResult.identities)) fail("RUNTIME_IDENTITY_CHANGED");
  return nextResult.observed;
}

async function createLearnerApprovalGate(input) {
  if (!PURPOSES.has(input.purpose) || !isRevision(input.revision)) fail("INPUT_INVALID");
  const boundary = bindApprovalBoundary(input);
  const environment = bindProductionEnvironment();
  const initial = collectRuntimeSnapshot(environment, input.purpose);
  const currentRevision = initial.application?.status?.sync?.revision;
  if (!isRevision(currentRevision) || currentRevision === input.revision) fail("APPLICATION_REVISION_INVALID");
  validateRuntimeSnapshot(initial, { purpose: input.purpose, currentRevision });
  inspectGitCandidate({ source: boundary.source, revision: input.revision, currentRevision, purpose: input.purpose }, { gitRun: environment.gitRun });

  let observed;
  if (input.purpose === "promote-v2") {
    observed = { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: currentRevision };
  } else {
    await delay(15_000);
    observed = assertStableValidatedRuntime(initial, collectRuntimeSnapshot(environment, input.purpose), input.purpose, currentRevision);
  }

  assertApprovalBoundaryUnchanged(boundary, { gateExpected: false });
  assertProductionEnvironmentUnchanged(environment);
  inspectGitCandidate({ source: boundary.source, revision: input.revision, currentRevision, purpose: input.purpose }, { gitRun: environment.gitRun });
  const beforePublish = collectRuntimeSnapshot(environment, input.purpose);
  observed = assertStableValidatedRuntime(initial, beforePublish, input.purpose, currentRevision);
  assertApprovalBoundaryUnchanged(boundary, { gateExpected: false });

  const gate = openApprovalGate(boundary.approval, input.revision, input.purpose, observed);
  let handoff;
  try {
    handoff = writeApprovalGateHandoff(gate.binding);
    assertApprovalBoundaryUnchanged(boundary, { gateExpected: true, gateBinding: gate.binding });
    assertApprovalGateHandoff(handoff);
    assertProductionEnvironmentUnchanged(environment);
    inspectGitCandidate({ source: boundary.source, revision: input.revision, currentRevision, purpose: input.purpose }, { gitRun: environment.gitRun });
    assertStableValidatedRuntime(initial, collectRuntimeSnapshot(environment, input.purpose), input.purpose, currentRevision);
    assertApprovalBoundaryUnchanged(boundary, { gateExpected: true, gateBinding: gate.binding });
    assertApprovalGateHandoff(handoff);
  } catch (error) {
    let cleanupFailure;
    if (handoff) {
      try { removeOwnedApprovalGateHandoff(handoff.ownership); } catch (cleanupError) { cleanupFailure = cleanupError; }
    }
    try { removeOwnedApprovalGate(gate.ownership); } catch (cleanupError) { cleanupFailure ??= cleanupError; }
    if (cleanupFailure) fail("GATE_POSTCHECK_AND_CLEANUP_FAILED", `${error.message}; ${cleanupFailure.message}`);
    throw error;
  }
  return { approval: boundary.approval, gate: gate.binding.path, observed, purpose: input.purpose, revision: input.revision };
}

async function main() {
  try {
    const result = await createLearnerApprovalGate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Approval gate opened for ${result.revision} (${result.purpose}).\n`);
    process.stdout.write(`Gate: ${result.gate}\n`);
  } catch (error) {
    const code = /^[A-Z_]+/.test(error?.message ?? "") ? error.message : `GATE_OPEN_FAILED: ${error.message}`;
    process.stderr.write(`Approval gate not opened: ${code}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

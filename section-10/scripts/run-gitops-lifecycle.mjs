#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { IMAGE as GIT_IMAGE, resolveRancherDesktopDockerHost, runGitProbe, startGitMirror } from "./start-git-mirror.mjs";
import { stopGitMirror } from "./stop-git-mirror.mjs";

export const EXACT = Object.freeze({
  cluster: "agentic-iac-s10",
  context: "kind-agentic-iac-s10",
  node: "agentic-iac-s10-control-plane",
  argocdNamespace: "argocd",
  workloadNamespace: "inference",
  release: "argocd",
  application: "inference-platform",
  gitContainer: "agentic-iac-s10-git",
});

function fail(code, detail = "") { throw new Error(`${code}${detail ? `: ${detail}` : ""}`); }

export function assertRuntimeNames(names) {
  if (JSON.stringify(names) !== JSON.stringify(EXACT)) fail("RUNTIME_NAME_MISMATCH");
}

export function assertApplicationContract(manifest) {
  if (!/^apiVersion: argoproj\.io\/v1alpha1$/m.test(manifest)
    || !/^kind: Application$/m.test(manifest)
    || !/^  name: inference-platform$/m.test(manifest)
    || !/^  namespace: argocd$/m.test(manifest)
    || !/repoURL: git:\/\/agentic-iac-s10-git:9418\/delivery\.git/.test(manifest)
    || !/targetRevision: HEAD/.test(manifest)
    || !/path: section-10\/starter\/gitops\/chart/.test(manifest)
    || !/namespace: inference/.test(manifest)) fail("APPLICATION_CONTRACT_INVALID");
  if (/^\s+automated:/m.test(manifest)) fail("AUTOMATED_SYNC_FORBIDDEN");
  return true;
}

export function assertApprovedRevision(path, revision, purpose) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) fail("APPROVAL_RECORD_INVALID");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schema !== "agentic-iac-s10-human-approval/v1"
    || value.approved !== true
    || value.approved_by !== "human-platform-reviewer"
    || value.requested_by !== "agent-author") fail("APPROVAL_RECORD_INVALID");
  if (value.revision !== revision) fail("UNAPPROVED_REVISION");
  if (value.purpose !== purpose) fail("APPROVAL_PURPOSE_MISMATCH");
  return value;
}

export function assertCleanPreflight(observed) {
  const present = Object.entries(observed).filter(([, value]) => value === true).map(([key]) => key);
  if (present.length) fail("PREEXISTING_NAMED_RESOURCE", present.join(","));
}

export function assertNoDirectPromotion({ previousRevision, nextRevision, mutationCommand }) {
  if (mutationCommand) fail("DIRECT_LIVE_PROMOTION_FORBIDDEN");
  if (previousRevision === nextRevision) fail("REVISION_DID_NOT_CHANGE");
  if (!/^[0-9a-f]{40}$/.test(previousRevision) || !/^[0-9a-f]{40}$/.test(nextRevision)) fail("REVISION_INVALID");
}

export function assertExternalSecret(observed) {
  if (!observed.exists || observed.name !== "inference-platform-backend-token" || observed.namespace !== EXACT.workloadNamespace) fail("EXTERNAL_SECRET_MISSING");
}

export function assertReadOnlyMirror(observed) {
  if (!observed.readOnlyRootfs || !observed.mountReadOnly || observed.receivePack) fail("WRITABLE_GIT_TRANSPORT");
}

export function recordPeak(measurements, sample) {
  if (sample.node !== EXACT.node) fail("SAMPLE_NODE_MISMATCH");
  if (!Number.isFinite(sample.bytes) || sample.bytes < 0) fail("SAMPLE_INVALID");
  measurements.samples.push(sample);
  measurements.peak_bytes = Math.max(measurements.peak_bytes, sample.bytes);
  if (sample.bytes > 4 * 1024 ** 3) fail("RESOURCE_LIMIT_EXCEEDED");
}

export function normalizeNodeImageReference(image) {
  const firstSegment = image.split("/", 1)[0];
  if (firstSegment === "localhost" || firstSegment.includes(".") || firstSegment.includes(":")) return image;
  return `docker.io/${image}`;
}

export function deadlineAction({ now, deadline, termSentAt, killGrace }) {
  if (termSentAt == null) return now >= deadline ? "SIGTERM" : null;
  return now >= termSentAt + killGrace ? "SIGKILL" : null;
}

export function workloadRolloutTargets() {
  return ["inference-platform-api", "inference-platform-dependencies", "inference-platform-worker"];
}

function waitForWorkloadRollouts(records) {
  for (const deployment of workloadRolloutTargets()) {
    execute("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "rollout", "status", `deployment/${deployment}`, "--timeout=180s"], { records, timeout: 210_000 });
  }
}

const KIND_IMAGE = "kindest/node@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const WORKLOAD_IMAGES = ["309-agentic-iac/inference-platform:s10-v1", "309-agentic-iac/inference-platform:s10-v2"];
const CHART_VERSION = "10.4.0";
const APP_VERSION = "3.5.1";
const sectionRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repositoryRoot = resolve(sectionRoot, "..");
const trustedTemporaryDirectory = realpathSync(tmpdir());

export function helmInstallArgs({ waitStrategy = "legacy" } = {}) {
  if (waitStrategy !== "legacy") fail("HELM_WAIT_STRATEGY_FORBIDDEN", waitStrategy);
  return ["upgrade", "--install", EXACT.release, "argo/argo-cd", "--version", CHART_VERSION, "--kube-context", EXACT.context,
    "--namespace", EXACT.argocdNamespace, "--create-namespace", "-f", join(sectionRoot, "argocd", "values.yaml"),
    "--wait=legacy", "--timeout", "8m"];
}

export function helmUninstallArgs({ wait = false } = {}) {
  if (wait) fail("HELM_UNINSTALL_WAIT_FORBIDDEN");
  return ["--kube-context", EXACT.context, "-n", EXACT.argocdNamespace, "uninstall", EXACT.release, "--timeout", "3m"];
}

export function canonicalMirrorRoot(input) {
  const requested = resolve(input);
  const parent = dirname(requested);
  if (basename(requested) !== "agentic-iac-s10-gitops" || lstatSync(parent).isSymbolicLink()) fail("MIRROR_PARENT_FORBIDDEN");
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== trustedTemporaryDirectory) fail("MIRROR_PARENT_FORBIDDEN");
  return join(canonicalParent, basename(requested));
}

function parseArgs(argv) {
  const allowed = ["--delivery-root", "--mirror-root", "--v1-revision", "--v2-revision", "--revert-revision", "--approval-v1", "--approval-v2", "--approval-revert"];
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.includes(key) || index + 1 >= argv.length || argv[index + 1].startsWith("--") || Object.hasOwn(values, key)) fail("USAGE", key);
    values[key] = argv[index + 1];
  }
  for (const key of allowed) if (!Object.hasOwn(values, key)) fail("USAGE", `missing ${key}`);
  return values;
}

function verifiedDockerDirectory() {
  const account = userInfo();
  const lexical = join(account.homedir, ".rd", "bin", "docker");
  if (!existsSync(lexical) || !lstatSync(lexical).isSymbolicLink()) fail("TRUSTED_DOCKER_MISSING");
  const canonical = realpathSync(lexical);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || ![0, account.uid].includes(stat.uid)
    || !canonical.startsWith("/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/")) fail("TRUSTED_DOCKER_INVALID");
  return { accountHome: account.homedir, directory: dirname(canonical) };
}

export function commandEnvironment() {
  const docker = verifiedDockerDirectory();
  const env = { HOME: docker.accountHome, TMPDIR: trustedTemporaryDirectory, DOCKER_HOST: resolveRancherDesktopDockerHost(), KIND_EXPERIMENTAL_PROVIDER: "docker", LANG: "C", LC_ALL: "C", PATH: `${docker.directory}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
  return env;
}

function redact(value, redactions) {
  let sanitized = String(value ?? "");
  for (const secret of redactions) if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  return sanitized;
}

export function executeWithHardTimeout(tool, args, { records, accepted = [0], timeout = 600_000, killGrace = 5_000, input, redactions = [] } = {}) {
  const started = Date.now();
  const supervisor = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "--supervise"], {
    encoding: "utf8", shell: false, env: commandEnvironment(),
    input: JSON.stringify({ tool, args, timeout, killGrace, input_base64: input == null ? null : Buffer.from(input).toString("base64") }),
    maxBuffer: 48 * 1024 * 1024,
  });
  if (supervisor.status !== 0) fail("SUPERVISOR_FAILED", supervisor.stderr || supervisor.stdout);
  let result;
  try { result = JSON.parse(supervisor.stdout); } catch (error) { fail("SUPERVISOR_RESULT_INVALID", error.message); }
  const timedOut = result.timed_out === true;
  const fullStdout = redact(Buffer.from(result.stdout_base64, "base64").toString("utf8").trim(), redactions);
  const fullStderr = redact(Buffer.from(result.stderr_base64, "base64").toString("utf8").trim(), redactions);
  const bounded = (value) => value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n[OUTPUT TRUNCATED; verify sha256 and byte count]`;
  const record = { at: new Date().toISOString(), controller: "bundled-node", tool, args: args.map((arg) => redact(arg, redactions)), exit: result.exit, signal: result.signal, timed_out: timedOut, elapsed_ms: Date.now() - started, stdout: bounded(fullStdout), stdout_bytes: Buffer.byteLength(fullStdout), stdout_sha256: sha256(fullStdout), stderr: bounded(fullStderr), stderr_bytes: Buffer.byteLength(fullStderr), stderr_sha256: sha256(fullStderr) };
  records?.push(record);
  if (!accepted.includes(result.exit)) fail(timedOut ? "COMMAND_HARD_TIMEOUT" : "COMMAND_FAILED", `${tool} ${record.args.join(" ")}\n${record.stderr || record.stdout}`);
  return { ...record, stdout: fullStdout, stderr: fullStderr };
}

export function execute(tool, args, options = {}) { return executeWithHardTimeout(tool, args, options); }

export function task4Runtime(records, { executor = execute, probe = runGitProbe } = {}) {
  const adapt = (result) => ({ status: result.exit, stdout: result.stdout, stderr: result.stderr });
  const docker = (args, accepted = [0]) => adapt(executor("docker", args, { records, accepted }));
  return {
    docker,
    git: (args, _accepted, expectedImageId, expectedImageLabels, expectedImageEnvironment) => probe(docker, args, { expectedImageEnvironment, expectedImageId, expectedImageLabels }),
  };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function requiredArgoImages(rendered) {
  return [...new Set([...rendered.matchAll(/^\s+image:\s+"?([^"\s]+)"?\s*$/gm)].map((match) => match[1]))].sort();
}

export function transportTagFor(image) {
  const tags = {
    "ecr-public.aws.com/docker/library/redis:8.6.4-alpine": "agentic-iac-s10/redis-transport:8.6.4",
    "quay.io/argoproj/argocd:v3.5.1": "agentic-iac-s10/argocd-transport:v3.5.1",
  };
  if (!Object.hasOwn(tags, image)) fail("ARGO_IMAGE_SET_CHANGED", image);
  return tags[image];
}
function jsonCommand(tool, args, options) {
  const result = execute(tool, args, options);
  try { return JSON.parse(result.stdout); } catch (error) { fail("JSON_OUTPUT_INVALID", `${tool}: ${error.message}`); }
}

function git(root, args, records) { return execute("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { records }); }

function verifyDeliveryRepository(rootInput, revisions, records) {
  const root = realpathSync(resolve(rootInput));
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail("DELIVERY_ROOT_INVALID");
  for (const revision of revisions) {
    if (!/^[0-9a-f]{40}$/.test(revision)) fail("REVISION_INVALID");
    if (git(root, ["cat-file", "-t", revision], records).stdout !== "commit") fail("REVISION_INVALID", revision);
  }
  return root;
}

function imageIdentity(image, records) {
  const data = jsonCommand("docker", ["image", "inspect", image], { records });
  if (!Array.isArray(data) || data.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(data[0].Id ?? "")) fail("IMAGE_IDENTITY_INVALID", image);
  return { reference: image, id: data[0].Id, repo_digests: data[0].RepoDigests ?? [], architecture: data[0].Architecture, size: data[0].Size };
}

function observedPreflight(records) {
  const clusters = execute("kind", ["get", "clusters"], { records }).stdout.split(/\r?\n/).filter(Boolean);
  const node = execute("docker", ["container", "inspect", EXACT.node], { records, accepted: [0, 1] }).exit === 0;
  const gitContainer = execute("docker", ["container", "inspect", EXACT.gitContainer], { records, accepted: [0, 1] }).exit === 0;
  return { cluster: clusters.includes(EXACT.cluster), node, application: false, release: false, argocdNamespace: false, workloadNamespace: false, gitContainer };
}

function startSampler() {
  return spawn(process.execPath, [new URL(import.meta.url).pathname, "--sample-node"], { stdio: ["ignore", "pipe", "pipe"], env: commandEnvironment() });
}

async function stopSampler(child, measurements) {
  child.kill("SIGTERM");
  const output = [];
  for await (const chunk of child.stdout) output.push(chunk);
  for (const line of output.join("").split(/\r?\n/).filter(Boolean)) {
    try { recordPeak(measurements, JSON.parse(line)); } catch (error) { if (!/sample unavailable/.test(error.message)) throw error; }
  }
}

function sampleMode() {
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  const loop = async () => {
    while (!stopped) {
      const result = spawnSync("docker", ["stats", EXACT.node, "--no-stream", "--format", "{{.MemUsage}}"], { encoding: "utf8", shell: false, env: commandEnvironment(), timeout: 10_000 });
      let bytes = 0;
      let available = false;
      if (result.status === 0) {
        const value = result.stdout.trim().split("/")[0].trim();
        const match = value.match(/^([0-9.]+)([KMG]iB)$/);
        if (match) {
          const factor = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]];
          bytes = Math.round(Number(match[1]) * factor); available = true;
        }
      }
      process.stdout.write(`${JSON.stringify({ node: EXACT.node, bytes, available, at: new Date().toISOString() })}\n`);
      await delay(2_000);
    }
  };
  return loop();
}

async function superviseMode() {
  const request = JSON.parse(readFileSync(0, "utf8"));
  if (typeof request.tool !== "string" || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")
    || !Number.isFinite(request.timeout) || request.timeout <= 0 || !Number.isFinite(request.killGrace) || request.killGrace <= 0) process.exit(2);
  const child = spawn(request.tool, request.args, { detached: process.platform !== "win32", env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const collect = (target, key, chunk) => {
    if (key + chunk.length > 32 * 1024 * 1024) return false;
    target.push(chunk); return true;
  };
  child.stdout.on("data", (chunk) => { if (collect(stdout, stdoutBytes, chunk)) stdoutBytes += chunk.length; else killGroup("SIGKILL"); });
  child.stderr.on("data", (chunk) => { if (collect(stderr, stderrBytes, chunk)) stderrBytes += chunk.length; else killGroup("SIGKILL"); });
  let timedOut = false;
  let termSentAt = null;
  const killGroup = (signal) => {
    try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {}
  };
  const deadline = Date.now() + request.timeout;
  const checkEvery = Math.max(10, Math.min(250, request.timeout / 4, request.killGrace / 2));
  const deadlineTimer = setInterval(() => {
    const now = Date.now();
    const action = deadlineAction({ now, deadline, termSentAt, killGrace: request.killGrace });
    if (action === "SIGTERM") {
      timedOut = true;
      termSentAt = now;
      killGroup(action);
    } else if (action === "SIGKILL") {
      killGroup(action);
    }
  }, checkEvery);
  if (request.input_base64 != null) child.stdin.end(Buffer.from(request.input_base64, "base64")); else child.stdin.end();
  const closed = await new Promise((resolveClose) => child.once("close", (exit, signal) => resolveClose({ exit, signal })));
  clearInterval(deadlineTimer);
  process.stdout.write(JSON.stringify({ ...closed, timed_out: timedOut, stdout_base64: Buffer.concat(stdout).toString("base64"), stderr_base64: Buffer.concat(stderr).toString("base64") }));
}

async function waitApplication(revision, records, { sync = "Synced", health = "Healthy", phase = "Succeeded", timeoutMs = 300_000 } = {}) {
  const started = Date.now();
  let last = {};
  while (Date.now() - started < timeoutMs) {
    const result = execute("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "application", EXACT.application, "-o", "json"], { records, accepted: [0, 1], timeout: 30_000 });
    if (result.exit === 0) {
      last = JSON.parse(result.stdout);
      const operation = last.status?.operationState?.phase;
      if (last.status?.sync?.revision === revision && last.status?.sync?.status === sync && last.status?.health?.status === health && (phase == null || operation === phase)) return last;
    }
    await delay(3_000);
  }
  fail("APPLICATION_WAIT_TIMEOUT", JSON.stringify({ revision, sync, health, phase, last: last.status }));
}

async function waitOutOfSync(records) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    execute("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "annotate", "application", EXACT.application, "argocd.argoproj.io/refresh=hard", "--overwrite"], { records });
    const value = jsonCommand("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "application", EXACT.application, "-o", "json"], { records });
    if (value.status?.sync?.status === "OutOfSync") return value;
    await delay(3_000);
  }
  fail("DRIFT_NOT_OBSERVED");
}

async function waitCleanupAbsence(records, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = {
      application: execute("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "application", EXACT.application, "-o", "name"], { records, accepted: [0, 1], timeout: 30_000 }).exit === 0,
      release: execute("helm", ["--kube-context", EXACT.context, "-n", EXACT.argocdNamespace, "status", EXACT.release], { records, accepted: [0, 1], timeout: 30_000 }).exit === 0,
      argocd_namespace: execute("kubectl", ["--context", EXACT.context, "get", "namespace", EXACT.argocdNamespace, "-o", "name"], { records, accepted: [0, 1], timeout: 30_000 }).exit === 0,
      workload_namespace: execute("kubectl", ["--context", EXACT.context, "get", "namespace", EXACT.workloadNamespace, "-o", "name"], { records, accepted: [0, 1], timeout: 30_000 }).exit === 0,
    };
    if (Object.values(last).every((present) => present === false)) return last;
    await delay(2_000);
  }
  fail("KUBERNETES_CLEANUP_TIMEOUT", JSON.stringify(last));
}

async function requestResult(records) {
  const submit = execute("curl", ["-fsS", "-H", "Content-Type: application/json", "-d", '{"input":"gitops delivery"}', "http://127.0.0.1:18080/jobs"], { records });
  const id = JSON.parse(submit.stdout).job_id;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const get = execute("curl", ["-fsS", `http://127.0.0.1:18080/jobs/${id}`], { records, accepted: [0, 22] });
    if (get.exit === 0) {
      const body = JSON.parse(get.stdout);
      if (body.status === "complete") return body;
    }
    await delay(100);
  }
  fail("REQUEST_NOT_COMPLETE", id);
}

function explicitSync(revision, records) {
  execute("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "annotate", "application", EXACT.application, "argocd.argoproj.io/refresh=hard", "--overwrite"], { records });
  const operation = JSON.stringify({ operation: { initiatedBy: { username: "human-platform-reviewer" }, sync: { revision, prune: false, syncOptions: ["CreateNamespace=false"] } } });
  execute("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "patch", "application", EXACT.application, "--type=merge", "-p", operation], { records });
}

function inspectWorkload(records) {
  const deployment = jsonCommand("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "get", "deployment", "inference-platform-api", "-o", "json"], { records });
  const pods = jsonCommand("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "get", "pods", "-l", "app.kubernetes.io/component=api", "-o", "json"], { records });
  return { template_image: deployment.spec?.template?.spec?.containers?.[0]?.image, replicas: deployment.spec?.replicas, generation: deployment.metadata?.generation, pod_images: pods.items?.map((pod) => ({ name: pod.metadata.name, image: pod.spec.containers[0].image, image_id: pod.status.containerStatuses?.[0]?.imageID })) };
}

function mirror(root, revision, records) {
  git(root, ["checkout", "--detach", "--force", revision], records);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], records).stdout;
  if (status) fail("DELIVERY_REPOSITORY_DIRTY", status);
}

function prepareAndStartMirror(deliveryRoot, revision, mirrorRoot, records) {
  execute(process.execPath, [join(sectionRoot, "scripts", "prepare-git-mirror.mjs"), "--source", deliveryRoot, "--revision", revision, "--root", mirrorRoot], { records });
  const ready = startGitMirror({ rootInput: mirrorRoot, runtime: task4Runtime(records) });
  const container = jsonCommand("docker", ["container", "inspect", EXACT.gitContainer], { records })[0];
  assertReadOnlyMirror({ readOnlyRootfs: container.HostConfig?.ReadonlyRootfs, mountReadOnly: container.Mounts?.[0]?.RW === false, receivePack: container.Config?.Cmd?.some((item) => item === "--enable=receive-pack") });
  return ready;
}

function stopMirror(mirrorRoot, records) {
  return stopGitMirror({ rootInput: mirrorRoot, runtime: task4Runtime(records) });
}

export async function runGitOpsLifecycle(input) {
  const records = [];
  const measurements = { samples: [], peak_bytes: 0 };
  const started = Date.now();
  const revisions = { v1: input.v1Revision, v2: input.v2Revision, revert: input.revertRevision };
  const deliveryRoot = verifyDeliveryRepository(input.deliveryRoot, Object.values(revisions), records);
  const mirrorRoot = canonicalMirrorRoot(input.mirrorRoot);
  const approvals = {
    v1: assertApprovedRevision(input.approvalV1, revisions.v1, "promote-v1"),
    v2: assertApprovedRevision(input.approvalV2, revisions.v2, "promote-v2"),
    revert: assertApprovedRevision(input.approvalRevert, revisions.revert, "revert-and-recover"),
  };
  assertNoDirectPromotion({ previousRevision: revisions.v1, nextRevision: revisions.v2, mutationCommand: null });
  assertCleanPreflight(observedPreflight(records));
  const sampler = startSampler();
  const report = { schema: "agentic-iac-s10-gitops-lifecycle/v1", result: "IN_PROGRESS", started_at: new Date().toISOString(), exact_names: EXACT, frozen_versions: { kind_image: KIND_IMAGE, argo_chart: CHART_VERSION, argo_application: APP_VERSION, git_image: GIT_IMAGE }, revisions, approvals, commands: records, measurements, observations: {}, cleanup: {}, proof_limits: ["Local course approval records bind revisions but do not prove an external identity provider.", "The read-only Git daemon is anonymous local course transport, not production authentication or authorization.", "The Git revision probe runs in a hardened disposable client on the Kind network; it does not prove host bridge reachability.", "Node-container docker stats measures the named course node, not the Docker Desktop VM working set.", "The authoring-host live run used macOS sleep prevention; caffeinate is not a learner dependency."] };
  let mirrorActive = false;
  let clusterCreated = false;
  try {
    execute("docker", ["build", "--label", "com.schoolofdevops.course=agentic-iac-s10", "--label", "com.schoolofdevops.release=s10-v1", "-t", WORKLOAD_IMAGES[0], join(repositoryRoot, "section-9", "app")], { records, timeout: 900_000 });
    execute("docker", ["build", "--label", "com.schoolofdevops.course=agentic-iac-s10", "--label", "com.schoolofdevops.release=s10-v2", "-t", WORKLOAD_IMAGES[1], join(repositoryRoot, "section-9", "app")], { records, timeout: 900_000 });
    report.observations.images = WORKLOAD_IMAGES.map((image) => imageIdentity(image, records));
    if (report.observations.images[0].id === report.observations.images[1].id) fail("IMAGE_IDENTITIES_NOT_DISTINCT");

    const renderedArgo = execute("helm", ["template", EXACT.release, "argo/argo-cd", "--version", CHART_VERSION, "--namespace", EXACT.argocdNamespace, "-f", join(sectionRoot, "argocd", "values.yaml")], { records, timeout: 120_000 });
    const argoImages = requiredArgoImages(renderedArgo.stdout);
    if (JSON.stringify(argoImages) !== JSON.stringify(["ecr-public.aws.com/docker/library/redis:8.6.4-alpine", "quay.io/argoproj/argocd:v3.5.1"])) fail("ARGO_IMAGE_SET_CHANGED", JSON.stringify(argoImages));
    report.observations.argocd_render = { sha256: sha256(renderedArgo.stdout), bytes: Buffer.byteLength(renderedArgo.stdout), images: argoImages };
    for (const image of argoImages) execute("docker", ["pull", "--platform", "linux/arm64", image], { records, timeout: 300_000 });
    report.observations.argocd_source_images = argoImages.map((image) => imageIdentity(image, records));
    execute("docker", ["pull", "--platform", "linux/arm64", GIT_IMAGE], { records, timeout: 300_000 });
    report.observations.git_transport_image = imageIdentity(GIT_IMAGE, records);
    report.observations.argocd_transport_images = [];
    for (const image of argoImages) {
      const transport = transportTagFor(image);
      execute("docker", ["build", "--provenance=false", "--platform", "linux/arm64", "-t", transport, "-"], { records, timeout: 300_000, input: `FROM ${image}\n` });
      const transportIdentity = imageIdentity(transport, records);
      execute("docker", ["tag", transport, image], { records, timeout: 60_000 });
      report.observations.argocd_transport_images.push({ source_reference: image, ...transportIdentity, loaded_reference: image });
    }

    execute("kind", ["create", "cluster", "--name", EXACT.cluster, "--image", KIND_IMAGE, "--config", join(sectionRoot, "tools", "kind", "cluster.yaml"), "--wait", "180s"], { records, timeout: 300_000 });
    clusterCreated = true;
    for (const image of [...WORKLOAD_IMAGES, ...argoImages]) execute("kind", ["load", "docker-image", image, "--name", EXACT.cluster], { records, timeout: 180_000 });
    const nodeImages = jsonCommand("docker", ["exec", EXACT.node, "crictl", "images", "-o", "json"], { records, timeout: 60_000 });
    const nodeTags = new Set(nodeImages.images?.flatMap((image) => image.repoTags ?? []) ?? []);
    const expectedNodeImages = [...WORKLOAD_IMAGES, ...argoImages].map((sourceReference) => ({
      source_reference: sourceReference,
      node_reference: normalizeNodeImageReference(sourceReference),
    }));
    for (const image of expectedNodeImages) if (!nodeTags.has(image.node_reference)) fail("NODE_IMAGE_MISSING", image.node_reference);
    report.observations.node_images_before_helm = expectedNodeImages;

    execute("helm", helmInstallArgs(), { records, timeout: 600_000 });
    const pods = jsonCommand("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "pods", "-o", "json"], { records });
    report.observations.argocd_pods = pods.items.map((pod) => ({ name: pod.metadata.name, phase: pod.status.phase, image: pod.spec.containers[0].image }));
    report.observations.applicationset = { rendered: true, replicas: jsonCommand("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "deployment", "argocd-applicationset-controller", "-o", "json"], { records }).spec.replicas };

    execute("kubectl", ["--context", EXACT.context, "create", "namespace", EXACT.workloadNamespace], { records });
    execute("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "create", "secret", "generic", "inference-platform-backend-token", "--from-literal=token=s10-runtime-token"], { records, redactions: ["s10-runtime-token"] });
    execute("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "create", "configmap", "agentic-iac-s10-lifecycle-owner", "--from-literal=cluster=agentic-iac-s10", "--from-literal=application=inference-platform"], { records });
    const secretName = execute("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "get", "secret", "inference-platform-backend-token", "-o", "jsonpath={.metadata.name}"], { records }).stdout;
    assertExternalSecret({ exists: secretName === "inference-platform-backend-token", name: secretName, namespace: EXACT.workloadNamespace });

    mirror(deliveryRoot, revisions.v1, records);
    report.observations.v1_mirror = prepareAndStartMirror(deliveryRoot, revisions.v1, mirrorRoot, records); mirrorActive = true;
    execute("kubectl", ["--context", EXACT.context, "apply", "-f", join(sectionRoot, "argocd", "application.yaml")], { records });
    const application = jsonCommand("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "application", EXACT.application, "-o", "json"], { records });
    if (application.spec?.syncPolicy?.automated !== undefined) fail("AUTOMATED_SYNC_FORBIDDEN");
    explicitSync(revisions.v1, records);
    report.observations.v1_application = (await waitApplication(revisions.v1, records)).status;
    waitForWorkloadRollouts(records);
    report.observations.v1_workload = inspectWorkload(records);

    stopMirror(mirrorRoot, records); mirrorActive = false;
    mirror(deliveryRoot, revisions.v2, records);
    report.observations.v2_mirror = prepareAndStartMirror(deliveryRoot, revisions.v2, mirrorRoot, records); mirrorActive = true;
    explicitSync(revisions.v2, records);
    report.observations.v2_application = (await waitApplication(revisions.v2, records)).status;
    waitForWorkloadRollouts(records);
    report.observations.v2_workload = inspectWorkload(records);
    if (report.observations.v1_workload.template_image === report.observations.v2_workload.template_image) fail("POD_TEMPLATE_DID_NOT_CHANGE");
    report.observations.request = await requestResult(records);

    execute("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "scale", "deployment", "inference-platform-api", "--replicas=2"], { records });
    report.observations.drift = (await waitOutOfSync(records)).status;
    await delay(15_000);
    const drifted = inspectWorkload(records);
    if (drifted.replicas !== 2) fail("AUTOMATIC_SELF_HEAL_OBSERVED");
    report.observations.drift_after_15_seconds = drifted;

    stopMirror(mirrorRoot, records); mirrorActive = false;
    mirror(deliveryRoot, revisions.revert, records);
    report.observations.revert_mirror = prepareAndStartMirror(deliveryRoot, revisions.revert, mirrorRoot, records); mirrorActive = true;
    explicitSync(revisions.revert, records);
    report.observations.recovery_application = (await waitApplication(revisions.revert, records)).status;
    waitForWorkloadRollouts(records);
    report.observations.recovery_workload = inspectWorkload(records);
    report.result = "PASS";
  } catch (error) {
    report.result = "FAIL"; report.failure = error.message;
  } finally {
    const cleanupErrors = [];
    const attempt = async (step, action) => {
      try { return await action(); } catch (error) { cleanupErrors.push({ step, error: error.message }); return null; }
    };
    let clusterOwned = false;
    if (clusterCreated) {
      const inspected = await attempt("validate-kind-ownership", () => jsonCommand("docker", ["inspect", EXACT.node], { records, timeout: 30_000 }));
      clusterOwned = inspected?.[0]?.Config?.Labels?.["io.x-k8s.kind.cluster"] === EXACT.cluster;
    }
    const owner = clusterCreated
      ? await attempt("read-lifecycle-owner", () => execute("kubectl", ["--context", EXACT.context, "-n", EXACT.workloadNamespace, "get", "configmap", "agentic-iac-s10-lifecycle-owner", "-o", "json"], { records, accepted: [0, 1], timeout: 30_000 }))
      : null;
    const configMapOwned = owner?.exit === 0 && JSON.parse(owner.stdout).data?.cluster === EXACT.cluster;
    report.cleanup.live_ownership_validated = clusterOwned || configMapOwned;
    if (clusterOwned) {
      await attempt("delete-application", () => execute("kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "delete", "application", EXACT.application, "--ignore-not-found=true", "--wait=false"], { records, accepted: [0, 1], timeout: 30_000 }));
      await attempt("request-release-uninstall", () => execute("helm", helmUninstallArgs(), { records, accepted: [0, 1], timeout: 210_000 }));
      await attempt("delete-workload-namespace", () => execute("kubectl", ["--context", EXACT.context, "delete", "namespace", EXACT.workloadNamespace, "--ignore-not-found=true", "--wait=false"], { records, accepted: [0, 1], timeout: 30_000 }));
      await attempt("delete-argocd-namespace", () => execute("kubectl", ["--context", EXACT.context, "delete", "namespace", EXACT.argocdNamespace, "--ignore-not-found=true", "--wait=false"], { records, accepted: [0, 1], timeout: 30_000 }));
      report.cleanup.kubernetes_absence_before_cluster_delete = await attempt("wait-kubernetes-absence", () => waitCleanupAbsence(records));
    }
    if (existsSync(mirrorRoot)) await attempt("stop-git-mirror", () => stopMirror(mirrorRoot, records));
    if (clusterOwned) await attempt("delete-kind-cluster", () => execute("kind", ["delete", "cluster", "--name", EXACT.cluster], { records, accepted: [0], timeout: 180_000 }));
    await delay(2_500);
    report.cleanup.absence = await attempt("prove-final-absence", () => observedPreflight(records)) ?? { cluster: true };
    report.cleanup.errors = cleanupErrors;
    report.cleanup.status = Object.values(report.cleanup.absence).every((value) => value === false) && !existsSync(mirrorRoot) ? "PASS" : "FAIL";
    await stopSampler(sampler, measurements);
    report.completed_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
    report.measurements.peak_gib = Number((measurements.peak_bytes / 1024 ** 3).toFixed(3));
    report.measurements.boundary = "docker stats for exact named Kind node only; Docker configured capacity is separate";
  }
  if (report.result !== "PASS" || report.cleanup.status !== "PASS") fail("LIFECYCLE_FAILED", JSON.stringify(report));
  return report;
}

function isMain() { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; }
if (isMain()) {
  if (process.argv[2] === "--sample-node") sampleMode().catch(() => { process.exitCode = 1; });
  else if (process.argv[2] === "--supervise") superviseMode().catch((error) => { console.error(error.message); process.exitCode = 2; });
  else {
    const args = parseArgs(process.argv.slice(2));
    runGitOpsLifecycle({ deliveryRoot: args["--delivery-root"], mirrorRoot: args["--mirror-root"], v1Revision: args["--v1-revision"], v2Revision: args["--v2-revision"], revertRevision: args["--revert-revision"], approvalV1: args["--approval-v1"], approvalV2: args["--approval-v2"], approvalRevert: args["--approval-revert"] })
      .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
      .catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 2; });
  }
}

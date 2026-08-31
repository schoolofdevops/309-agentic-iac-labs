import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  commandEnvironment,
  deadlineAction,
  execute,
  executeWithHardTimeout,
  requiredArgoImages,
  transportTagFor,
  normalizeNodeImageReference,
  recordPeak,
  verifyRevisionLineage,
  waitForApprovedRevision,
  workloadRolloutTargets,
} from "../scripts/run-gitops-lifecycle.mjs";

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
  const gateMs = Date.now();
  setTimeout(() => writeFileSync(v2, `${JSON.stringify({ schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author", revision, purpose: "promote-v2", approved: true })}\n`, { mode: 0o600 }), 20);
  const observed = await waitForApprovedRevision(v2, revision, "promote-v2", { gateMs, timeoutMs: 500, pollMs: 5 });
  assert.equal(observed.revision, revision);
  assert.ok(Date.parse(observed.file.mtime) >= gateMs);
  assert.match(observed.file.identity_sha256, /^[0-9a-f]{64}$/);
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
  assert.match(lineage.v1_to_v2.patch_sha256, /^[0-9a-f]{64}$/);
  spawnSync("git", ["-C", root, "checkout", "-q", "--orphan", "unrelated"]);
  rmSync(join(root, "version.txt"));
  mkdirSync(join(root, "branch"));
  writeFileSync(join(root, "branch", "other.txt"), "other\n");
  spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "unrelated"]);
  const unrelated = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.throws(() => verifyRevisionLineage(root, { v1, v2: unrelated, revert: recovery }, []), /V2_NOT_DIRECT_SUCCESSOR/);
  rmSync(root, { recursive: true });
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const prepare = join(sectionRoot, "scripts", "prepare-git-mirror.mjs");
const start = join(sectionRoot, "scripts", "start-git-mirror.mjs");
const stop = join(sectionRoot, "scripts", "stop-git-mirror.mjs");
const image = "alpine/git@sha256:6f8eae2205a85c51106a9650e574a37fb1d5e4f645e5f6ea57cb57b9462cd4cf";

function command(executable, args, options = {}) {
  return spawnSync(executable, args, { encoding: "utf8", shell: false, ...options });
}

function git(cwd, args, env = process.env) {
  const result = command("git", args, { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeSource() {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-source-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Section 10 Test"]);
  git(root, ["config", "user.email", "section10@example.invalid"]);
  mkdirSync(join(root, "delivery"));
  writeFileSync(join(root, "delivery", "version.txt"), "s10-v1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "approved v1"]);
  const first = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "delivery", "version.txt"), "s10-v2\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "approved v2"]);
  return { root, first, head: git(root, ["rev-parse", "HEAD"]) };
}

function newMirrorRoot() {
  const parent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-parent-"));
  rmSync(parent, { recursive: true });
  return `${parent}-mirror`;
}

function prepareMirror(source, root = newMirrorRoot(), revision = source.head, extra = []) {
  const result = command(process.execPath, [prepare, "--source", source.root, "--revision", revision, "--root", root, ...extra]);
  return { ...result, root };
}

function makeFakeRuntime({ network = true, node = true, existing = false, probeRevision = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-runtime-"));
  const docker = join(root, "docker");
  const probe = join(root, "git");
  const log = join(root, "docker.log");
  const state = join(root, "state.json");
  writeFileSync(state, `${JSON.stringify({ network, node, existing })}\n`);
  writeFileSync(docker, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(state)};
const logPath = ${JSON.stringify(log)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
const out = (text) => process.stdout.write(text + "\\n");
if (args[0] === "network" && args[1] === "inspect") process.exit(state.network ? 0 : 1);
if (args[0] === "container" && args[1] === "inspect" && args[2] === "agentic-iac-s10-control-plane") {
  if (!state.node) process.exit(1);
  out(JSON.stringify([{ Name: "agentic-iac-s10-control-plane", Config: { Labels: { "io.x-k8s.kind.cluster": "agentic-iac-s10" } }, NetworkSettings: { Networks: { kind: { IPAddress: "172.18.0.2" } } } }]));
  process.exit(0);
}
if (args[0] === "container" && args[1] === "inspect" && args[2] === "agentic-iac-s10-git") {
  if (!state.existing) process.exit(1);
  out(JSON.stringify([{ Id: state.owned ? "created-container" : "existing-container", Config: { Labels: state.owned ? { "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-mirror", "com.schoolofdevops.source-revision": state.sourceRevision } : { "com.schoolofdevops.fixture": "foreign" } }, NetworkSettings: { Networks: { kind: { IPAddress: "172.18.0.3" } } } }]));
  process.exit(0);
}
if (args[0] === "run") { state.existing = true; state.owned = true; state.sourceRevision = args.find((arg) => arg.startsWith("--label=com.schoolofdevops.source-revision=")).split("=").at(-1); fs.writeFileSync(statePath, JSON.stringify(state)); out("created-container"); process.exit(0); }
if (args[0] === "inspect" && args[1] === "agentic-iac-s10-git") {
  out(JSON.stringify([{ Id: "created-container", Config: { Labels: { "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-mirror", "com.schoolofdevops.source-revision": state.sourceRevision } }, NetworkSettings: { Networks: { kind: { IPAddress: "172.18.0.3" } } } }]));
  process.exit(0);
}
if (args[0] === "rm" && args[1] === "-f" && args[2] === "agentic-iac-s10-git") { state.existing = false; fs.writeFileSync(statePath, JSON.stringify(state)); process.exit(0); }
process.stderr.write("unexpected docker call: " + JSON.stringify(args) + "\\n");
process.exit(72);
`);
  writeFileSync(probe, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "ls-remote" || args[1] !== "git://172.18.0.3:9418/delivery.git" || args[2] !== "refs/heads/main") process.exit(73);
process.stdout.write(${JSON.stringify(probeRevision)} + "\\trefs/heads/main\\n");
`);
  chmodSync(docker, 0o500);
  chmodSync(probe, 0o500);
  return { root, docker, probe, log, state, env: process.env };
}

function startMirror(mirror, runtime) {
  return command(process.execPath, [start, "--root", mirror.root, "--docker-path", runtime.docker, "--git-path", runtime.probe], { env: runtime.env });
}

function dockerCalls(runtime) {
  if (!existsSync(runtime.log)) return [];
  return readFileSync(runtime.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function cleanup(...paths) {
  for (const path of paths) if (path) rmSync(path, { recursive: true, force: true });
}

test("prepares only the explicit clean HEAD as delivery.git without hooks, credentials, or worktree-only files", () => {
  const source = makeSource();
  mkdirSync(join(source.root, ".git", "hooks"), { recursive: true });
  writeFileSync(join(source.root, ".git", "hooks", "post-receive"), "credential-token\n");
  git(source.root, ["config", "credential.helper", "learner-secret-helper"]);
  const globalRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-home-"));
  writeFileSync(join(globalRoot, ".gitconfig"), "[credential]\n\thelper = global-secret-helper\n");
  const result = command(process.execPath, [prepare, "--source", source.root, "--revision", source.head, "--root", newMirrorRoot()], { env: { ...process.env, HOME: globalRoot } });
  assert.equal(result.status, 0, result.stderr);
  const ready = JSON.parse(result.stdout);
  assert.equal(ready.repository_name, "delivery.git");
  assert.equal(ready.source_revision, source.head);
  assert.equal(git(source.root, ["--git-dir", join(ready.root, "delivery.git"), "rev-parse", "refs/heads/main"]), source.head);
  assert.equal(existsSync(join(ready.root, "delivery.git", "hooks")), false);
  const mirrorConfig = readFileSync(join(ready.root, "delivery.git", "config"), "utf8");
  assert.doesNotMatch(mirrorConfig, /credential|learner-secret|global-secret|receivepack/i);
  assert.equal(existsSync(join(ready.root, "delivery.git", "git-daemon-export-ok")), false);
  cleanup(ready.root, source.root, globalRoot);
});

test("rejects a dirty source, stale revision, non-temporary root, and symlink ancestor", () => {
  const source = makeSource();
  writeFileSync(join(source.root, "untracked.txt"), "not reviewed\n");
  let result = prepareMirror(source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SOURCE_NOT_CLEAN/);
  unlinkSync(join(source.root, "untracked.txt"));

  result = prepareMirror(source, newMirrorRoot(), source.first);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REVISION_NOT_HEAD/);

  result = prepareMirror(source, join(source.root, "mirror"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROOT_OUTSIDE_TEMP/);

  const realParent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-real-"));
  const linkParent = `${realParent}-link`;
  symlinkSync(realParent, linkParent, "dir");
  result = prepareMirror(source, join(linkParent, "agentic-iac-s10-mirror"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SYMLINK_ANCESTOR/);
  cleanup(source.root, realParent, linkParent);
});

test("refuses readiness when the kind network is absent or not owned by the exact Section 10 cluster", () => {
  const source = makeSource();
  const missingNetworkMirror = prepareMirror(source);
  assert.equal(missingNetworkMirror.status, 0, missingNetworkMirror.stderr);
  const noNetwork = makeFakeRuntime({ network: false, probeRevision: source.head });
  let result = startMirror(missingNetworkMirror, noNetwork);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KIND_NETWORK_MISSING/);
  assert.equal(dockerCalls(noNetwork).some((args) => args[0] === "run"), false);

  const noNodeMirror = prepareMirror(source);
  assert.equal(noNodeMirror.status, 0, noNodeMirror.stderr);
  const noNode = makeFakeRuntime({ node: false, probeRevision: source.head });
  result = startMirror(noNodeMirror, noNode);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECTION10_CLUSTER_MISSING/);
  assert.equal(dockerCalls(noNode).some((args) => args[0] === "run"), false);
  cleanup(source.root, missingNetworkMirror.root, noNetwork.root, noNodeMirror.root, noNode.root);
});

test("rejects a pre-existing named container before running the pinned read-only daemon", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ existing: true, probeRevision: source.head });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GIT_CONTAINER_EXISTS/);
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "run"), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("starts only the exact pinned, read-only, upload-pack-only daemon and proves the explicit revision", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head });
  const result = startMirror(mirror, runtime);
  assert.equal(result.status, 0, result.stderr);
  const ready = JSON.parse(result.stdout);
  assert.equal(ready.endpoint, "git://172.18.0.3:9418/delivery.git");
  assert.equal(ready.source_revision, source.head);
  assert.equal(ready.transport_scope, "anonymous local course transport; not production authentication or authorization");
  const run = dockerCalls(runtime).find((args) => args[0] === "run");
  assert.ok(run);
  assert.ok(run.includes("--name=agentic-iac-s10-git"));
  assert.ok(run.includes("--network=kind"));
  assert.ok(run.includes("--read-only"));
  assert.ok(run.includes("--cap-drop=ALL"));
  assert.ok(run.includes("--security-opt=no-new-privileges"));
  assert.ok(run.some((arg) => arg.startsWith("--mount=type=bind,") && arg.endsWith(",readonly")));
  assert.ok(run.includes("--entrypoint=git"));
  assert.ok(run.includes(image));
  assert.ok(run.includes("daemon"));
  assert.ok(run.includes("--enable=upload-pack"));
  assert.ok(run.includes("--disable=receive-pack"));
  assert.ok(run.includes("--disable=upload-archive"));
  cleanup(source.root, mirror.root, runtime.root);
});

test("removes its failed container and does not report ready when ls-remote returns another revision", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.first });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REVISION_PROBE_FAILED/);
  assert.deepEqual(dockerCalls(runtime).at(-1), ["rm", "-f", "agentic-iac-s10-git"]);
  assert.equal(existsSync(join(mirror.root, "git-mirror-ready.json")), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("stop removes only its exact labeled container and directly marked temporary root", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head });
  const started = startMirror(mirror, runtime);
  assert.equal(started.status, 0, started.stderr);
  const result = command(process.execPath, [stop, "--root", mirror.root, "--docker-path", runtime.docker], { env: runtime.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(mirror.root), false);
  assert.deepEqual(dockerCalls(runtime).at(-1), ["rm", "-f", "agentic-iac-s10-git"]);
  cleanup(source.root, runtime.root);
});

test("stop rejects an otherwise owned container whose revision label no longer matches its marker", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head });
  const started = startMirror(mirror, runtime);
  assert.equal(started.status, 0, started.stderr);
  const changedState = JSON.parse(readFileSync(runtime.state, "utf8"));
  changedState.sourceRevision = source.first;
  writeFileSync(runtime.state, JSON.stringify(changedState));
  const result = command(process.execPath, [stop, "--root", mirror.root, "--docker-path", runtime.docker], { env: runtime.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONTAINER_OWNERSHIP_MISMATCH/);
  assert.ok(existsSync(mirror.root));
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "rm"), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("stop rejects an unmarked or symlinked root and a foreign container without broad cleanup", () => {
  const runtime = makeFakeRuntime({ existing: true });
  const unmarked = mkdtempSync(join(tmpdir(), "agentic-iac-s10-unmarked-"));
  writeFileSync(join(unmarked, "keep.txt"), "keep\n");
  let result = command(process.execPath, [stop, "--root", unmarked, "--docker-path", runtime.docker], { env: runtime.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNERSHIP_MARKER/);
  assert.ok(existsSync(join(unmarked, "keep.txt")));
  assert.equal(dockerCalls(runtime).length, 0);

  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const marker = join(mirror.root, ".agentic-iac-s10-git-mirror.json");
  unlinkSync(marker);
  symlinkSync(join(unmarked, "keep.txt"), marker);
  result = command(process.execPath, [stop, "--root", mirror.root, "--docker-path", runtime.docker], { env: runtime.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNERSHIP_MARKER/);
  assert.ok(existsSync(mirror.root));

  unlinkSync(marker);
  writeFileSync(marker, `${JSON.stringify({ task_id: "section-10-task-4", root: realpathSync(mirror.root), repository_name: "delivery.git", source_revision: source.head })}\n`);
  result = command(process.execPath, [stop, "--root", mirror.root, "--docker-path", runtime.docker], { env: runtime.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONTAINER_OWNERSHIP_MISMATCH/);
  assert.ok(existsSync(mirror.root));
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "rm"), false);
  cleanup(runtime.root, unmarked, source.root, mirror.root);
});

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
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FixtureError } from "../scripts/prepare-git-mirror.mjs";
import { DAEMON_COMMAND, IMAGE, startGitMirror } from "../scripts/start-git-mirror.mjs";
import * as startModule from "../scripts/start-git-mirror.mjs";
import { stopGitMirror } from "../scripts/stop-git-mirror.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const prepare = join(sectionRoot, "scripts", "prepare-git-mirror.mjs");
const start = join(sectionRoot, "scripts", "start-git-mirror.mjs");
const stop = join(sectionRoot, "scripts", "stop-git-mirror.mjs");
const image = "bitnami/git@sha256:972d6f1ac0e2b62f689794c56620f75d18f22be8f1069554a7622622e5bed548";

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

function makeFakeRuntime({ network = true, node = true, existing = false, probeRevision = "", badUser = false, rmSticks = false, rmFails = false, mutateContainer, mutateImage } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-runtime-"));
  const calls = [];
  const state = { network, node, existing, owned: false, sourceRevision: undefined, badUser, rmSticks, rmFails };
  const containerId = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const imageLabels = { "org.opencontainers.image.title": "git", "org.opencontainers.image.version": "test" };
  function result(status, stdout = "", stderr = "", accepted = [0]) {
    const value = { status, stdout, stderr };
    if (!accepted.includes(status)) throw new FixtureError("COMMAND_FAILED", stderr || stdout);
    return value;
  }
  function container() {
    const value = {
      Id: state.owned ? containerId : "c".repeat(64),
      Image: imageId,
      Name: "/agentic-iac-s10-git",
      State: { Running: true },
      Config: {
        Image: IMAGE,
        User: state.badUser ? "0:0" : "65534:65534",
        Entrypoint: ["git"],
        Cmd: [...DAEMON_COMMAND],
        Labels: state.owned ? { ...imageLabels,
          "com.schoolofdevops.course": "agentic-iac-s10",
          "com.schoolofdevops.fixture": "git-mirror",
          "com.schoolofdevops.source-revision": state.sourceRevision,
        } : { "com.schoolofdevops.fixture": "foreign" },
      },
      HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], NetworkMode: "kind" },
      Mounts: [{ Type: "bind", Source: state.repository, Destination: "/git/delivery.git", RW: false }],
      NetworkSettings: { Networks: { kind: { IPAddress: "172.18.0.3" } } },
    };
    if (mutateContainer) mutateContainer(value);
    return value;
  }
  const runtime = {
    root, calls, state,
    docker(args, accepted = [0]) {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") return result(state.network ? 0 : 1, state.network ? "[{}]\n" : "", "network missing", accepted);
      if (args[0] === "container" && args[1] === "inspect" && args[2] === "agentic-iac-s10-control-plane") {
        if (!state.node) return result(1, "", "No such container: agentic-iac-s10-control-plane", accepted);
        return result(0, `${JSON.stringify([{ Name: "/agentic-iac-s10-control-plane", Config: { Labels: { "io.x-k8s.kind.cluster": "agentic-iac-s10" } }, NetworkSettings: { Networks: { kind: { IPAddress: "172.18.0.2" } } } }])}\n`, "", accepted);
      }
      if (args[0] === "container" && args[1] === "inspect" && args[2] === "agentic-iac-s10-git") {
        if (!state.existing) return result(1, "", "Error: No such container: agentic-iac-s10-git", accepted);
        return result(0, `${JSON.stringify([container()])}\n`, "", accepted);
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const value = {
          Architecture: "arm64",
          Id: imageId,
          RepoDigests: [IMAGE],
          Config: {
            Entrypoint: ["/opt/bitnami/scripts/git/entrypoint.sh"],
            Cmd: ["/bin/bash"],
            WorkingDir: "/",
            Labels: imageLabels,
          },
        };
        if (mutateImage) mutateImage(value);
        return result(0, `${JSON.stringify([value])}\n`, "", accepted);
      }
      if (args[0] === "run") {
        state.existing = true; state.owned = true;
        state.sourceRevision = args.find((arg) => arg.startsWith("--label=com.schoolofdevops.source-revision=")).split("=").at(-1);
        state.repository = args.find((arg) => arg.startsWith("--mount=type=bind,")).match(/src=([^,]+)/)[1];
        return result(0, `${containerId}\n`, "", accepted);
      }
      if (args[0] === "rm" && args[1] === "-f" && args[2] === "agentic-iac-s10-git") {
        if (state.rmFails) return result(75, "", "rm failed", accepted);
        if (!state.rmSticks) state.existing = false;
        return result(0, `${containerId}\n`, "", accepted);
      }
      return result(72, "", `unexpected docker call: ${JSON.stringify(args)}`, accepted);
    },
    git(args, accepted = [0]) {
      if (args[0] !== "ls-remote" || args[1] !== "git://172.18.0.3:9418/delivery.git" || args[2] !== "refs/heads/main") return result(73, "", "unexpected git call", accepted);
      return result(0, `${probeRevision}\trefs/heads/main\n`, "", accepted);
    },
  };
  return runtime;
}

function startMirror(mirror, runtime) {
  try { return { status: 0, stdout: `${JSON.stringify(startGitMirror({ rootInput: mirror.root, runtime }))}\n`, stderr: "" }; }
  catch (error) { return { status: 1, stdout: "", stderr: `${error.code ?? "UNEXPECTED"}: ${error.message}\n` }; }
}

function dockerCalls(runtime) {
  return runtime.calls;
}

function stopMirror(mirror, runtime) {
  try { return { status: 0, stdout: `${JSON.stringify(stopGitMirror({ rootInput: mirror.root, runtime }))}\n`, stderr: "" }; }
  catch (error) { return { status: 1, stdout: "", stderr: `${error.code ?? "UNEXPECTED"}: ${error.message}\n` }; }
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
  assert.deepEqual(run.slice(run.indexOf(image) + 1, run.indexOf(image) + 3), ["-c", "safe.directory=/git/delivery.git"]);
  assert.ok(run.includes("daemon"));
  assert.ok(run.includes("--enable=upload-pack"));
  assert.ok(run.includes("--disable=receive-pack"));
  assert.ok(run.includes("--disable=upload-archive"));
  cleanup(source.root, mirror.root, runtime.root);
});

test("production revision probes run inside the Kind network without mounts or mutable pulls", () => {
  const endpoint = "git://172.19.0.3:9418/delivery.git";
  const nonce = "1".repeat(64);
  assert.equal(typeof startModule.gitProbeDockerArgs, "function");
  assert.deepEqual(startModule.gitProbeDockerArgs(["ls-remote", endpoint, "refs/heads/main"], nonce), [
    "create", "--rm", "--name=agentic-iac-s10-git-probe", "--network=kind", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--user=65534:65534", "--pull=never",
    "--label=com.schoolofdevops.course=agentic-iac-s10", "--label=com.schoolofdevops.fixture=git-probe",
    `--label=com.schoolofdevops.probe-nonce=${nonce}`,
    "--env=GIT_CONFIG=/dev/null", "--env=GIT_CONFIG_GLOBAL=/dev/null", "--env=GIT_CONFIG_NOSYSTEM=1",
    "--env=GIT_TERMINAL_PROMPT=0", "--env=HOME=/nonexistent",
    "--entrypoint=git", image, "ls-remote", endpoint, "refs/heads/main",
  ]);
});

test("a failed production revision probe removes only its exact owned container and proves absence", () => {
  const args = ["ls-remote", "git://172.19.0.3:9418/delivery.git", "refs/heads/main"];
  const nonce = "2".repeat(64);
  const probeId = "d".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const calls = [];
  let removed = false;
  const docker = (commandArgs) => {
    calls.push(commandArgs);
    if (commandArgs[0] === "container" && commandArgs[1] === "inspect") {
      if (commandArgs[2] === "agentic-iac-s10-git-probe" || removed) return { status: 1, stdout: "", stderr: `Error: No such container: ${commandArgs[2]}` };
      return { status: 0, stdout: `${JSON.stringify([{
        Id: probeId, Image: imageId, Name: "/agentic-iac-s10-git-probe",
        Config: { Image: image, User: "65534:65534", Entrypoint: ["git"], Cmd: args, Env: ["GIT_CONFIG=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "HOME=/nonexistent"], Labels: { "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-probe", "com.schoolofdevops.probe-nonce": nonce } },
        HostConfig: { AutoRemove: true, Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], NetworkMode: "kind" },
        Mounts: [], NetworkSettings: { Networks: { kind: { IPAddress: "172.19.0.4" } } },
      }])}\n`, stderr: "" };
    }
    if (commandArgs[0] === "create") return { status: 0, stdout: `${probeId}\n`, stderr: "" };
    if (commandArgs[0] === "start") throw new FixtureError("COMMAND_FAILED", "probe timed out");
    if (JSON.stringify(commandArgs) === JSON.stringify(["rm", "-f", probeId])) { removed = true; return { status: 0, stdout: `${probeId}\n`, stderr: "" }; }
    throw new Error(`unexpected call ${JSON.stringify(commandArgs)}`);
  };
  assert.throws(() => startModule.runGitProbe(docker, args, { expectedImageId: imageId, nonce }), (error) => error.code === "COMMAND_FAILED");
  assert.ok(calls.some((value) => JSON.stringify(value) === JSON.stringify(["rm", "-f", probeId])));
  assert.deepEqual(calls.slice(-2), [["container", "inspect", probeId], ["container", "inspect", "agentic-iac-s10-git-probe"]]);
});

test("probe cleanup rejects mutated ownership and runtime fields without deleting", () => {
  const args = ["ls-remote", "git://172.19.0.3:9418/delivery.git", "refs/heads/main"];
  const nonce = "3".repeat(64);
  const probeId = "e".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const mutations = [
    ["container ID", (value) => { value.Id = "f".repeat(64); }],
    ["nonce", (value) => { value.Config.Labels["com.schoolofdevops.probe-nonce"] = "4".repeat(64); }],
    ["extra label", (value) => { value.Config.Labels["attacker.example/owner"] = "forged"; }],
    ["extra environment", (value) => { value.Config.Env.push("GIT_CONFIG=/attacker"); }],
    ["auto-remove", (value) => { value.HostConfig.AutoRemove = false; }],
    ["privileged", (value) => { value.HostConfig.Privileged = true; }],
    ["image ID", (value) => { value.Image = `sha256:${"a".repeat(64)}`; }],
    ["command", (value) => { value.Config.Cmd = ["status"]; }],
    ["mount", (value) => { value.Mounts = [{ Type: "volume", Destination: "/data", RW: true }]; }],
  ];
  for (const [name, mutate] of mutations) {
    const calls = [];
    let inspectIdCount = 0;
    const docker = (commandArgs) => {
      calls.push(commandArgs);
      if (commandArgs[0] === "container" && commandArgs[1] === "inspect" && commandArgs[2] === "agentic-iac-s10-git-probe") return { status: 1, stdout: "", stderr: "Error: No such container: agentic-iac-s10-git-probe" };
      if (commandArgs[0] === "create") return { status: 0, stdout: `${probeId}\n`, stderr: "" };
      if (commandArgs[0] === "container" && commandArgs[1] === "inspect" && commandArgs[2] === probeId) {
        inspectIdCount += 1;
        const value = { Id: probeId, Image: imageId, Name: "/agentic-iac-s10-git-probe", Config: { Image: image, User: "65534:65534", Entrypoint: ["git"], Cmd: args, Env: ["GIT_CONFIG=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "HOME=/nonexistent"], Labels: { "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-probe", "com.schoolofdevops.probe-nonce": nonce } }, HostConfig: { AutoRemove: true, Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], NetworkMode: "kind" }, Mounts: [], NetworkSettings: { Networks: { kind: { IPAddress: "172.19.0.4" } } } };
        if (inspectIdCount === 2) mutate(value);
        return { status: 0, stdout: `${JSON.stringify([value])}\n`, stderr: "" };
      }
      if (commandArgs[0] === "start") throw new FixtureError("COMMAND_FAILED", "probe timed out");
      throw new Error(`unexpected call ${JSON.stringify(commandArgs)}`);
    };
    assert.throws(() => startModule.runGitProbe(docker, args, { expectedImageId: imageId, nonce }), (error) => error.code === "GIT_PROBE_OWNERSHIP_MISMATCH", name);
    assert.equal(calls.some((value) => value[0] === "rm"), false, name);
  }
});

test("probe cleanup never deletes a foreign name replacement after its captured ID disappears", () => {
  const args = ["ls-remote", "git://172.19.0.3:9418/delivery.git", "refs/heads/main"];
  const nonce = "5".repeat(64);
  const probeId = "6".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  let nameInspects = 0;
  let idInspects = 0;
  const calls = [];
  const docker = (commandArgs) => {
    calls.push(commandArgs);
    if (commandArgs[0] === "container" && commandArgs[1] === "inspect" && commandArgs[2] === "agentic-iac-s10-git-probe") {
      nameInspects += 1;
      if (nameInspects === 1) return { status: 1, stdout: "", stderr: "Error: No such container: agentic-iac-s10-git-probe" };
      return { status: 0, stdout: `${JSON.stringify([{ Id: "7".repeat(64), Name: "/agentic-iac-s10-git-probe" }])}\n`, stderr: "" };
    }
    if (commandArgs[0] === "create") return { status: 0, stdout: `${probeId}\n`, stderr: "" };
    if (commandArgs[0] === "container" && commandArgs[1] === "inspect" && commandArgs[2] === probeId) {
      idInspects += 1;
      if (idInspects > 1) return { status: 1, stdout: "", stderr: `Error: No such container: ${probeId}` };
      return { status: 0, stdout: `${JSON.stringify([{ Id: probeId, Image: imageId, Name: "/agentic-iac-s10-git-probe", Config: { Image: image, User: "65534:65534", Entrypoint: ["git"], Cmd: args, Env: ["GIT_CONFIG=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "HOME=/nonexistent"], Labels: { "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-probe", "com.schoolofdevops.probe-nonce": nonce } }, HostConfig: { AutoRemove: true, Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], NetworkMode: "kind" }, Mounts: [], NetworkSettings: { Networks: { kind: { IPAddress: "172.19.0.4" } } } }])}\n`, stderr: "" };
    }
    if (commandArgs[0] === "start") throw new FixtureError("COMMAND_FAILED", "probe timed out");
    throw new Error(`unexpected call ${JSON.stringify(commandArgs)}`);
  };
  assert.throws(() => startModule.runGitProbe(docker, args, { expectedImageId: imageId, nonce }), (error) => error.code === "GIT_PROBE_NAME_REUSED");
  assert.equal(calls.some((value) => value[0] === "rm"), false);
});

test("container absence matching rejects a suffixed probe name", () => {
  const calls = [];
  const docker = (commandArgs) => {
    calls.push(commandArgs);
    return { status: 1, stdout: "", stderr: "Error: No such container: agentic-iac-s10-git-probe-suffix" };
  };
  assert.throws(() => startModule.runGitProbe(docker, ["ls-remote"], { expectedImageId: `sha256:${"b".repeat(64)}`, nonce: "8".repeat(64) }), (error) => error.code === "GIT_PROBE_ABSENCE_UNPROVEN");
  assert.equal(calls.some((value) => value[0] === "create"), false);
});

test("rejects an image that declares storage outside the exact repository bind", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({
    probeRevision: source.head,
    mutateImage: (value) => { value.Config.Volumes = { "/git": {} }; },
  });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GIT_IMAGE_INVALID/);
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "run"), false);
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
  assert.ok(dockerCalls(runtime).some((args) => JSON.stringify(args) === JSON.stringify(["rm", "-f", "agentic-iac-s10-git"])));
  assert.deepEqual(dockerCalls(runtime).at(-1), ["container", "inspect", "agentic-iac-s10-git"]);
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
  const result = stopMirror(mirror, runtime);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(mirror.root), false);
  assert.ok(dockerCalls(runtime).some((args) => JSON.stringify(args) === JSON.stringify(["rm", "-f", "agentic-iac-s10-git"])));
  assert.deepEqual(dockerCalls(runtime).at(-1), ["container", "inspect", "agentic-iac-s10-git"]);
  cleanup(source.root, runtime.root);
});

test("stop rejects an otherwise owned container whose revision label no longer matches its marker", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head });
  const started = startMirror(mirror, runtime);
  assert.equal(started.status, 0, started.stderr);
  runtime.state.sourceRevision = source.first;
  const result = stopMirror(mirror, runtime);
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
  let result = stopMirror({ root: unmarked }, runtime);
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
  result = stopMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNERSHIP_MARKER/);
  assert.ok(existsSync(mirror.root));

  unlinkSync(marker);
  writeFileSync(marker, `${JSON.stringify({ task_id: "section-10-task-4", root: realpathSync(mirror.root), repository_name: "delivery.git", source_revision: source.head })}\n`);
  result = stopMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNERSHIP_MARKER/);
  assert.ok(existsSync(mirror.root));
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "rm"), false);
  cleanup(runtime.root, unmarked, source.root, mirror.root);
});

test("malicious repository-local fsmonitor and upload-pack hooks never execute during preparation", () => {
  const source = makeSource();
  const maliciousRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-malicious-"));
  const marker = join(maliciousRoot, "malicious-config-ran");
  const hook = join(maliciousRoot, "malicious-hook");
  writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(hook, 0o700);
  git(source.root, ["config", "core.fsmonitor", hook]);
  git(source.root, ["config", "uploadpack.packObjectsHook", hook]);
  const result = prepareMirror(source);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false, "learner-local Git config must not execute");
  cleanup(source.root, result.root, maliciousRoot);
});

test("production CLI does not accept executable override flags", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head });
  const poison = join(runtime.root, "poison");
  writeFileSync(poison, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(join(runtime.root, "executed"))}, "yes")\n`);
  chmodSync(poison, 0o500);
  const result = command(process.execPath, [start, "--root", mirror.root, "--docker-path", poison, "--git-path", poison]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNKNOWN_ARGUMENT/);
  const stopResult = command(process.execPath, [stop, "--root", mirror.root, "--docker-path", poison]);
  assert.notEqual(stopResult.status, 0);
  assert.match(stopResult.stderr, /UNKNOWN_ARGUMENT/);
  assert.equal(existsSync(join(runtime.root, "executed")), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("stop rejects unexpected root inventory instead of deleting extra data", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  writeFileSync(join(mirror.root, "unrelated.txt"), "keep\n");
  const runtime = makeFakeRuntime();
  const result = stopMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROOT_INVENTORY_MISMATCH/);
  assert.ok(existsSync(join(mirror.root, "unrelated.txt")));
  cleanup(source.root, mirror.root, runtime.root);
});

test("READY rejects a container whose runtime user differs from the exact non-root contract", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head, badUser: true });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GIT_CONTAINER_INVALID/);
  assert.equal(existsSync(join(mirror.root, "git-mirror-ready.json")), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("cleanup preserves evidence when docker rm returns success but the exact container remains", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head, rmSticks: true });
  const started = startMirror(mirror, runtime);
  assert.equal(started.status, 0, started.stderr);
  const result = stopMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONTAINER_STILL_PRESENT/);
  assert.ok(existsSync(mirror.root));
  cleanup(source.root, mirror.root, runtime.root);
});

test("prepared-but-never-started cleanup validates absence and removes only its marked root", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime();
  const result = stopMirror(mirror, runtime);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).container_removed, false);
  assert.equal(existsSync(mirror.root), false);
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "rm"), false);
  cleanup(source.root, runtime.root);
});

test("cleanup preserves READY evidence when docker rm fails", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head, rmFails: true });
  assert.equal(startMirror(mirror, runtime).status, 0);
  const result = stopMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /COMMAND_FAILED/);
  assert.ok(existsSync(join(mirror.root, "git-mirror-ready.json")));
  cleanup(source.root, mirror.root, runtime.root);
});

test("failed-start cleanup preserves PREPARED evidence when container absence cannot be proved", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.first, rmSticks: true });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FAILED_START_CLEANUP_UNPROVEN/);
  assert.ok(existsSync(join(mirror.root, ".agentic-iac-s10-git-mirror.json")));
  assert.equal(existsSync(join(mirror.root, "git-mirror-ready.json")), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("altered lifecycle records and repository contents never authorize cleanup", () => {
  const source = makeSource();

  const alteredMarker = prepareMirror(source);
  assert.equal(alteredMarker.status, 0, alteredMarker.stderr);
  const markerPath = join(alteredMarker.root, ".agentic-iac-s10-git-mirror.json");
  chmodSync(markerPath, 0o600);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  marker.extra_authority = true;
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  let runtime = makeFakeRuntime();
  let result = stopMirror(alteredMarker, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNERSHIP_MARKER/);
  assert.ok(existsSync(alteredMarker.root));

  const mismatchedMarker = prepareMirror(source);
  assert.equal(mismatchedMarker.status, 0, mismatchedMarker.stderr);
  const mismatchedMarkerPath = join(mismatchedMarker.root, ".agentic-iac-s10-git-mirror.json");
  chmodSync(mismatchedMarkerPath, 0o600);
  const mismatched = JSON.parse(readFileSync(mismatchedMarkerPath, "utf8"));
  mismatched.repository_name = "other.git";
  writeFileSync(mismatchedMarkerPath, `${JSON.stringify(mismatched)}\n`);
  runtime = makeFakeRuntime();
  result = stopMirror(mismatchedMarker, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNERSHIP_MARKER/);
  assert.ok(existsSync(mismatchedMarker.root));

  const alteredRepository = prepareMirror(source);
  assert.equal(alteredRepository.status, 0, alteredRepository.stderr);
  writeFileSync(join(alteredRepository.root, "delivery.git", "extra"), "forged\n");
  runtime = makeFakeRuntime();
  result = stopMirror(alteredRepository, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MIRROR_CONTENT_MISMATCH/);
  assert.ok(existsSync(alteredRepository.root));

  const alteredRef = prepareMirror(source);
  assert.equal(alteredRef.status, 0, alteredRef.stderr);
  const updateRef = command("git", ["--git-dir", join(alteredRef.root, "delivery.git"), "update-ref", "refs/heads/main", source.first]);
  assert.equal(updateRef.status, 0, updateRef.stderr);
  runtime = makeFakeRuntime();
  result = stopMirror(alteredRef, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MIRROR_REF_MISMATCH/);
  assert.ok(existsSync(alteredRef.root));

  const alteredReady = prepareMirror(source);
  assert.equal(alteredReady.status, 0, alteredReady.stderr);
  runtime = makeFakeRuntime({ probeRevision: source.head });
  assert.equal(startMirror(alteredReady, runtime).status, 0);
  const readyPath = join(alteredReady.root, "git-mirror-ready.json");
  chmodSync(readyPath, 0o600);
  const ready = JSON.parse(readFileSync(readyPath, "utf8"));
  ready.endpoint = "git://attacker:9418/delivery.git";
  writeFileSync(readyPath, `${JSON.stringify(ready)}\n`);
  result = stopMirror(alteredReady, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /READY_RECORD_INVALID/);
  assert.ok(existsSync(alteredReady.root));
  cleanup(source.root, alteredMarker.root, mismatchedMarker.root, alteredRepository.root, alteredRef.root, alteredReady.root, runtime.root);
});

for (const [name, mutateContainer] of [
  ["container name", (value) => { value.Name = "/wrong"; }],
  ["image identity", (value) => { value.Image = `sha256:${"d".repeat(64)}`; }],
  ["running state", (value) => { value.State.Running = false; }],
  ["read-only root and capabilities", (value) => { value.HostConfig.ReadonlyRootfs = false; value.HostConfig.CapDrop = []; }],
  ["security options", (value) => { value.HostConfig.SecurityOpt = []; }],
  ["non-root user", (value) => { value.Config.User = "0:0"; }],
  ["read-only mirror mount", (value) => { value.Mounts[0].RW = true; }],
  ["network and discovered IP", (value) => { value.NetworkSettings.Networks.bridge = {}; }],
  ["daemon command", (value) => { value.Config.Cmd = value.Config.Cmd.filter((arg) => arg !== "--disable=receive-pack"); }],
  ["ownership labels", (value) => { value.Config.Labels["com.schoolofdevops.fixture"] = "foreign"; }],
]) {
  test(`READY rejects mutated ${name}`, () => {
    const source = makeSource();
    const mirror = prepareMirror(source);
    assert.equal(mirror.status, 0, mirror.stderr);
    const runtime = makeFakeRuntime({ probeRevision: source.head, mutateContainer });
    const result = startMirror(mirror, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GIT_CONTAINER_INVALID/);
    assert.equal(existsSync(join(mirror.root, "git-mirror-ready.json")), false);
    cleanup(source.root, mirror.root, runtime.root);
  });
}

test("READY rejects an image inspect result that is not bound to the pinned repository digest", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head, mutateImage: (value) => { value.RepoDigests = ["attacker/image@sha256:" + "0".repeat(64)]; } });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GIT_IMAGE_INVALID/);
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "run"), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("READY rejects an image whose inspected entrypoint differs from the pinned image contract", () => {
  const source = makeSource();
  const mirror = prepareMirror(source);
  assert.equal(mirror.status, 0, mirror.stderr);
  const runtime = makeFakeRuntime({ probeRevision: source.head, mutateImage: (value) => { value.Config.Entrypoint = ["sh"]; } });
  const result = startMirror(mirror, runtime);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GIT_IMAGE_INVALID/);
  assert.equal(dockerCalls(runtime).some((args) => args[0] === "run"), false);
  cleanup(source.root, mirror.root, runtime.root);
});

test("poisoned PATH Git and Docker tools never execute", () => {
  const source = makeSource();
  const poisonRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-path-"));
  const executed = join(poisonRoot, "executed");
  for (const name of ["git", "docker"]) {
    const path = join(poisonRoot, name);
    writeFileSync(path, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(executed)}, ${JSON.stringify(name)})\nprocess.exit(0)\n`);
    chmodSync(path, 0o500);
  }
  const mirrorRoot = newMirrorRoot();
  const prepared = command(process.execPath, [prepare, "--source", source.root, "--revision", source.head, "--root", mirrorRoot], { env: { ...process.env, PATH: poisonRoot } });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(existsSync(executed), false);
  const started = command(process.execPath, [start, "--root", join(poisonRoot, "agentic-iac-s10-missing")], { env: { ...process.env, PATH: poisonRoot } });
  assert.notEqual(started.status, 0, "an invalid root stops before any Docker state inspection");
  assert.equal(existsSync(executed), false);
  cleanup(source.root, mirrorRoot, poisonRoot);
});

function rancherDesktopMetadata(overrides = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return { candidateBasename: "docker", canonicalBasename: "docker", isRegularFile: true, isSymlink: true, canonicalPath: "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker", ownerUid: uid, expectedUid: uid, mode: 0o755, ...overrides };
}

function rancherDesktopSocketMetadata(overrides = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return { canonicalPath: join(userInfo().homedir, ".rd", "docker.sock"), expectedPath: join(userInfo().homedir, ".rd", "docker.sock"), isSocket: true, isSymlink: false, ownerUid: uid, expectedUid: uid, mode: 0o600, ...overrides };
}

test("trusted Docker metadata accepts only the exact canonical current-user Rancher Desktop symlink", () => {
  assert.doesNotThrow(() => startModule.validateRancherDesktopMetadata(rancherDesktopMetadata()));
});

test("trusted Docker discovery resolves this host's supported Rancher Desktop symlink without daemon access", { skip: !existsSync(join(userInfo().homedir, ".rd", "bin", "docker")) }, () => {
  assert.equal(startModule.resolveRancherDesktopDocker(), realpathSync(join(userInfo().homedir, ".rd", "bin", "docker")));
});

test("trusted Rancher Docker binds only the exact current-user socket", () => {
  assert.equal(typeof startModule.validateRancherDesktopSocketMetadata, "function");
  assert.doesNotThrow(() => startModule.validateRancherDesktopSocketMetadata(rancherDesktopSocketMetadata()));
  assert.throws(() => startModule.validateRancherDesktopSocketMetadata(rancherDesktopSocketMetadata({ isSocket: false })), (error) => error.code === "TRUSTED_DOCKER_SOCKET_INVALID");
  assert.throws(() => startModule.validateRancherDesktopSocketMetadata(rancherDesktopSocketMetadata({ isSymlink: true })), (error) => error.code === "TRUSTED_DOCKER_SOCKET_INVALID");
  assert.throws(() => startModule.validateRancherDesktopSocketMetadata(rancherDesktopSocketMetadata({ ownerUid: 0 })), (error) => error.code === "TRUSTED_DOCKER_SOCKET_INVALID");
  assert.throws(() => startModule.validateRancherDesktopSocketMetadata(rancherDesktopSocketMetadata({ mode: 0o622 })), (error) => error.code === "TRUSTED_DOCKER_SOCKET_INVALID");
  assert.throws(() => startModule.validateRancherDesktopSocketMetadata(rancherDesktopSocketMetadata({ canonicalPath: "/tmp/attacker.sock" })), (error) => error.code === "TRUSTED_DOCKER_SOCKET_INVALID");
});

test("trusted Rancher Docker resolves this host's socket without caller HOME or context", { skip: !existsSync(join(userInfo().homedir, ".rd", "docker.sock")) }, () => {
  assert.equal(startModule.resolveRancherDesktopDockerHost(), `unix://${realpathSync(join(userInfo().homedir, ".rd", "docker.sock"))}`);
});

test("Rancher Desktop discovery rejects a writable or wrong-version Docker binary", () => {
  assert.throws(() => startModule.validateRancherDesktopMetadata(rancherDesktopMetadata({ mode: 0o777 })), (error) => error.code === "TRUSTED_DOCKER_INVALID");
  assert.throws(() => startModule.validateRancherDesktopVersion({ status: 0, stdout: "podman version 5\n" }), (error) => error.code === "TRUSTED_DOCKER_INVALID");
});

test("Rancher Desktop discovery rejects an arbitrary symlink and wrong binary name", () => {
  assert.throws(() => startModule.validateRancherDesktopMetadata(rancherDesktopMetadata({ canonicalPath: "/tmp/attacker/docker" })), (error) => error.code === "UNTRUSTED_DOCKER_SYMLINK");
  assert.throws(() => startModule.validateRancherDesktopMetadata(rancherDesktopMetadata({ canonicalBasename: "podman" })), (error) => error.code === "TRUSTED_DOCKER_INVALID");
});

test("Rancher Desktop metadata rejects a wrong owner and wrong canonical binary name", () => {
  assert.equal(typeof startModule.validateRancherDesktopMetadata, "function");
  const safe = rancherDesktopMetadata();
  assert.throws(() => startModule.validateRancherDesktopMetadata({ ...safe, ownerUid: 0 }), (error) => error.code === "TRUSTED_DOCKER_INVALID");
  assert.throws(() => startModule.validateRancherDesktopMetadata({ ...safe, canonicalBasename: "podman" }), (error) => error.code === "TRUSTED_DOCKER_INVALID");
});

test("Rancher Desktop discovery ignores poisoned HOME and never executes its fake Docker", () => {
  const poisonHome = mkdtempSync(join(tmpdir(), "agentic-iac-s10-poison-home-"));
  const bin = join(poisonHome, ".rd", "bin");
  const marker = join(poisonHome, "executed");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")\nprocess.stdout.write("Docker version 29.5.3-rd, build fake\\n")\n`);
  chmodSync(join(bin, "docker"), 0o500);
  const code = `import { resolveRancherDesktopDocker } from ${JSON.stringify(new URL("../scripts/start-git-mirror.mjs", import.meta.url).href)}; process.stdout.write(resolveRancherDesktopDocker() + "\\n")`;
  const result = command(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HOME: poisonHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker");
  assert.equal(existsSync(marker), false);
  cleanup(poisonHome);
});

test("Rancher Desktop metadata rejects a direct account-home Docker file", () => {
  const direct = { candidateBasename: "docker", canonicalBasename: "docker", isRegularFile: true, isSymlink: false, canonicalPath: "/Users/learner/.rd/bin/docker", ownerUid: 501, expectedUid: 501, mode: 0o755 };
  assert.throws(() => startModule.validateRancherDesktopMetadata(direct), (error) => error.code === "TRUSTED_DOCKER_INVALID");
});

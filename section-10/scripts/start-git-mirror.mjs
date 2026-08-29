#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FixtureError, READY_NAME, TASK_ID, TRANSPORT_SCOPE, loadMirrorState, parseCliArgs, reject } from "./prepare-git-mirror.mjs";

export const CONTAINER = "agentic-iac-s10-git";
export const CLUSTER_NODE = "agentic-iac-s10-control-plane";
export const IMAGE = "alpine/git@sha256:6f8eae2205a85c51106a9650e574a37fb1d5e4f645e5f6ea57cb57b9462cd4cf";
export const DAEMON_COMMAND = ["daemon", "--reuseaddr", "--verbose", "--export-all", "--base-path=/git", "--port=9418", "--listen=0.0.0.0", "--enable=upload-pack", "--disable=receive-pack", "--disable=upload-archive", "/git/delivery.git"];

function minimalEnvironment() { return { GIT_CONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: realpathSync(tmpdir()), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" }; }
function currentUid() { return typeof process.getuid === "function" ? process.getuid() : statSync(realpathSync(tmpdir())).uid; }
function rawCommand(executable, args, accepted = [0]) {
  const result = spawnSync(executable, args, { encoding: "utf8", shell: false, env: minimalEnvironment(), timeout: 60_000, killSignal: "SIGKILL" });
  if (!accepted.includes(result.status)) reject("COMMAND_FAILED", result.error?.message ?? result.stderr ?? result.stdout);
  return result;
}
function resolveTrustedTool(candidates, versionArgs, versionPattern) {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const stats = lstatSync(canonical);
    if (!stats.isFile() || (stats.mode & 0o111) === 0 || (stats.mode & 0o022) !== 0 || ![0, currentUid()].includes(stats.uid)) continue;
    const version = rawCommand(canonical, versionArgs, [0, 1]);
    if (version.status === 0 && versionPattern.test(`${version.stdout}${version.stderr}`)) return canonical;
  }
  return undefined;
}

const RANCHER_DESKTOP_CANONICAL_DOCKER = "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker";

export function validateRancherDesktopMetadata(metadata) {
  if (metadata.candidateBasename !== "docker" || metadata.canonicalBasename !== "docker" || !metadata.isRegularFile || metadata.ownerUid !== metadata.expectedUid || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) reject("TRUSTED_DOCKER_INVALID", metadata.canonicalPath);
  if (metadata.isSymlink && metadata.canonicalPath !== RANCHER_DESKTOP_CANONICAL_DOCKER) reject("UNTRUSTED_DOCKER_SYMLINK", metadata.canonicalPath);
}

export function resolveRancherDesktopDocker({ homeDirectory = homedir() } = {}) {
  const candidate = join(resolve(homeDirectory), ".rd", "bin", "docker");
  if (basename(candidate) !== "docker" || !existsSync(candidate)) reject("TRUSTED_TOOL_MISSING", "Rancher Desktop docker");
  const lexical = lstatSync(candidate);
  const canonical = realpathSync(candidate);
  const stats = lstatSync(canonical);
  validateRancherDesktopMetadata({ candidateBasename: basename(candidate), canonicalBasename: basename(canonical), isRegularFile: stats.isFile(), isSymlink: lexical.isSymbolicLink(), canonicalPath: canonical, ownerUid: stats.uid, expectedUid: currentUid(), mode: stats.mode });
  const version = rawCommand(canonical, ["--version"], [0, 1]);
  if (version.status !== 0 || !/^Docker version \d+\.\d+\.\d+(?:-rd(?:\.\d+)?)?, build [A-Za-z0-9._+-]+\s*$/.test(version.stdout)) reject("TRUSTED_DOCKER_INVALID", "unexpected Rancher Desktop Docker version output");
  return canonical;
}

export function productionRuntime() {
  const dockerPath = resolveTrustedTool(["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"], ["--version"], /^Docker version \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?, build [A-Za-z0-9._+-]+\s*$/) ?? resolveRancherDesktopDocker();
  const gitPath = resolveTrustedTool(["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"], ["--version"], /^git version \d+\.\d+/);
  if (!gitPath) reject("TRUSTED_TOOL_MISSING", "git");
  return {
    docker: (args, accepted = [0]) => rawCommand(dockerPath, args, accepted),
    git: (args, accepted = [0]) => rawCommand(gitPath, args, accepted),
  };
}

function inspectOne(result, code) {
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1) reject(code, "inspect must return exactly one object");
    return values[0];
  } catch (error) { if (error instanceof FixtureError) throw error; reject(code, error.message); }
}
function isExactNotFound(result) { return result.status === 1 && /No such (?:object|container):?\s*agentic-iac-s10-git/i.test(result.stderr ?? ""); }

export function removeContainerAndProveAbsent(runtime) {
  runtime.docker(["rm", "-f", CONTAINER]);
  const after = runtime.docker(["container", "inspect", CONTAINER], [0, 1]);
  if (!isExactNotFound(after)) reject("CONTAINER_STILL_PRESENT", "docker did not prove exact container absence after rm");
}

function validateImage(runtime) {
  const image = inspectOne(runtime.docker(["image", "inspect", IMAGE]), "GIT_IMAGE_INVALID");
  if (!/^sha256:[0-9a-f]{64}$/.test(image.Id ?? "") || !Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(IMAGE) || !exactArray(image.Config?.Entrypoint, ["git"]) || !exactArray(image.Config?.Cmd, ["--help"]) || image.Config?.WorkingDir !== "/git" || ![undefined, ""].includes(image.Config?.User)) reject("GIT_IMAGE_INVALID", "pinned image digest or frozen image config is invalid");
  return { id: image.Id, labels: image.Config?.Labels ?? {} };
}
function exactArray(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
function exactRecord(actual, expected) { return JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort()); }
function validateContainer(container, expected) {
  const labels = container.Config?.Labels ?? {};
  const expectedLabels = { ...expected.imageLabels, "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-mirror", "com.schoolofdevops.source-revision": expected.revision };
  const mount = Array.isArray(container.Mounts) && container.Mounts.length === 1 ? container.Mounts[0] : undefined;
  const networks = container.NetworkSettings?.Networks ?? {};
  const valid =
    container.Id === expected.containerId && /^[0-9a-f]{64}$/.test(container.Id ?? "") &&
    container.Name === `/${CONTAINER}` && container.Image === expected.imageId && container.Config?.Image === IMAGE &&
    container.Config?.User === "65534:65534" && exactArray(container.Config?.Entrypoint, ["git"]) && exactArray(container.Config?.Cmd, DAEMON_COMMAND) &&
    exactRecord(labels, expectedLabels) &&
    container.State?.Running === true && container.HostConfig?.ReadonlyRootfs === true &&
    exactArray(container.HostConfig?.CapDrop, ["ALL"]) && (container.HostConfig?.CapAdd == null || exactArray(container.HostConfig.CapAdd, [])) &&
    exactArray(container.HostConfig?.SecurityOpt, ["no-new-privileges"]) && container.HostConfig?.NetworkMode === "kind" &&
    mount?.Type === "bind" && mount.Source === expected.repository && mount.Destination === "/git/delivery.git" && mount.RW === false &&
    exactArray(Object.keys(networks), ["kind"]) && typeof networks.kind?.IPAddress === "string" && networks.kind.IPAddress.length > 0;
  if (!valid) reject("GIT_CONTAINER_INVALID", "runtime container differs from the exact pinned read-only contract");
  return networks.kind.IPAddress;
}

export function startGitMirror({ rootInput, runtime }) {
  const prepared = loadMirrorState(rootInput, { require: "PREPARED" });
  const network = runtime.docker(["network", "inspect", "kind"], [0, 1]);
  if (network.status !== 0) reject("KIND_NETWORK_MISSING", "Docker network kind does not exist");
  const nodeResult = runtime.docker(["container", "inspect", CLUSTER_NODE], [0, 1]);
  if (nodeResult.status !== 0) reject("SECTION10_CLUSTER_MISSING", `required node ${CLUSTER_NODE} does not exist`);
  const node = inspectOne(nodeResult, "SECTION10_CLUSTER_INVALID");
  if (node.Name !== `/${CLUSTER_NODE}` || node.Config?.Labels?.["io.x-k8s.kind.cluster"] !== "agentic-iac-s10" || !node.NetworkSettings?.Networks?.kind) reject("SECTION10_CLUSTER_INVALID", "exact Section 10 Kind ownership is missing");
  const existing = runtime.docker(["container", "inspect", CONTAINER], [0, 1]);
  if (!isExactNotFound(existing)) reject(existing.status === 0 ? "GIT_CONTAINER_EXISTS" : "GIT_CONTAINER_ABSENCE_UNPROVEN", "refusing to create over an unknown container state");
  const image = validateImage(runtime);
  let created = false;
  try {
    const run = runtime.docker([
      "run", "-d", `--name=${CONTAINER}`, "--network=kind", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534",
      "--label=com.schoolofdevops.course=agentic-iac-s10", "--label=com.schoolofdevops.fixture=git-mirror", `--label=com.schoolofdevops.source-revision=${prepared.marker.source_revision}`,
      `--mount=type=bind,src=${prepared.repository},dst=/git/delivery.git,readonly`, "--entrypoint=git", IMAGE, ...DAEMON_COMMAND,
    ]);
    created = true;
    const containerId = run.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(containerId)) reject("GIT_CONTAINER_INVALID", "docker run did not return a full container ID");
    const container = inspectOne(runtime.docker(["container", "inspect", CONTAINER]), "GIT_CONTAINER_INVALID");
    const ip = validateContainer(container, { containerId, imageId: image.id, imageLabels: image.labels, repository: prepared.repository, revision: prepared.marker.source_revision });
    const endpoint = `git://${ip}:9418/delivery.git`;
    const probe = runtime.git(["ls-remote", endpoint, "refs/heads/main"], [0, 1]);
    const expected = `${prepared.marker.source_revision}\trefs/heads/main`;
    if (probe.status !== 0 || probe.stdout.trim() !== expected) reject("REVISION_PROBE_FAILED", probe.stderr || `${probe.stdout.trim()} != ${expected}`);
    const ready = { container_id: containerId, container_name: CONTAINER, endpoint, prepared_marker_sha256: prepared.marker_sha256, record_version: 1, repository_manifest_sha256: prepared.marker.repository_manifest_sha256, repository_name: "delivery.git", source_revision: prepared.marker.source_revision, state: "READY", task_id: TASK_ID, transport_scope: TRANSPORT_SCOPE };
    writeFileSync(join(prepared.root, READY_NAME), `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o400, flag: "wx" });
    loadMirrorState(prepared.root, { require: "READY" });
    return ready;
  } catch (error) {
    if (created) {
      try { removeContainerAndProveAbsent(runtime); }
      catch (cleanupError) { reject("FAILED_START_CLEANUP_UNPROVEN", `${error.message}; ${cleanupError.message}`); }
    }
    throw error;
  }
}

function isMain() { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; }
if (isMain()) {
  try {
    const args = parseCliArgs(process.argv.slice(2), ["--root"]);
    process.stdout.write(`${JSON.stringify(startGitMirror({ rootInput: args["--root"], runtime: productionRuntime() }))}\n`);
  } catch (error) { process.stderr.write(`${error instanceof FixtureError ? error.code : "UNEXPECTED"}: ${error.message}\n`); process.exitCode = 1; }
}

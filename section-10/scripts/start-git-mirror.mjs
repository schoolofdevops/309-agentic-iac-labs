#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FixtureError, READY_NAME, TASK_ID, TRANSPORT_SCOPE, loadMirrorState, parseCliArgs, reject } from "./prepare-git-mirror.mjs";

export const CONTAINER = "agentic-iac-s10-git";
export const PROBE_CONTAINER = "agentic-iac-s10-git-probe";
export const CLUSTER_NODE = "agentic-iac-s10-control-plane";
export const IMAGE = "bitnami/git@sha256:972d6f1ac0e2b62f689794c56620f75d18f22be8f1069554a7622622e5bed548";
export const DAEMON_COMMAND = ["-c", "safe.directory=/git/delivery.git", "daemon", "--reuseaddr", "--verbose", "--export-all", "--base-path=/git", "--port=9418", "--listen=0.0.0.0", "--enable=upload-pack", "--disable=receive-pack", "--disable=upload-archive", "/git/delivery.git"];

function minimalEnvironment() { return { GIT_CONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: realpathSync(tmpdir()), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" }; }
function currentUid() { return typeof process.getuid === "function" ? process.getuid() : statSync(realpathSync(tmpdir())).uid; }
function rawCommand(executable, args, accepted = [0], environment = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", shell: false, env: { ...minimalEnvironment(), ...environment }, timeout: 60_000, killSignal: "SIGKILL" });
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
  if (metadata.candidateBasename !== "docker" || !metadata.isSymlink) reject("TRUSTED_DOCKER_INVALID", metadata.canonicalPath);
  if (metadata.canonicalPath !== RANCHER_DESKTOP_CANONICAL_DOCKER) reject("UNTRUSTED_DOCKER_SYMLINK", metadata.canonicalPath);
  if (metadata.canonicalBasename !== "docker" || !metadata.isRegularFile || metadata.ownerUid !== metadata.expectedUid || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) reject("TRUSTED_DOCKER_INVALID", metadata.canonicalPath);
}

export function validateRancherDesktopVersion(result) {
  if (result.status !== 0 || !/^Docker version \d+\.\d+\.\d+(?:-rd(?:\.\d+)?)?, build [A-Za-z0-9._+-]+\s*$/.test(result.stdout)) reject("TRUSTED_DOCKER_INVALID", "unexpected Rancher Desktop Docker version output");
}

export function resolveRancherDesktopDocker() {
  const candidate = join(resolve(userInfo().homedir), ".rd", "bin", "docker");
  if (basename(candidate) !== "docker" || !existsSync(candidate)) reject("TRUSTED_TOOL_MISSING", "Rancher Desktop docker");
  const lexical = lstatSync(candidate);
  const canonical = realpathSync(candidate);
  const stats = lstatSync(canonical);
  validateRancherDesktopMetadata({ candidateBasename: basename(candidate), canonicalBasename: basename(canonical), isRegularFile: stats.isFile(), isSymlink: lexical.isSymbolicLink(), canonicalPath: canonical, ownerUid: stats.uid, expectedUid: currentUid(), mode: stats.mode });
  const version = rawCommand(canonical, ["--version"], [0, 1]);
  validateRancherDesktopVersion(version);
  return canonical;
}

export function validateRancherDesktopSocketMetadata(metadata) {
  if (
    metadata.canonicalPath !== metadata.expectedPath ||
    metadata.isSymlink ||
    !metadata.isSocket ||
    metadata.ownerUid !== metadata.expectedUid ||
    (metadata.mode & 0o077) !== 0
  ) reject("TRUSTED_DOCKER_SOCKET_INVALID", metadata.canonicalPath);
}

export function resolveRancherDesktopDockerHost() {
  const expected = join(resolve(userInfo().homedir), ".rd", "docker.sock");
  if (!existsSync(expected)) reject("TRUSTED_DOCKER_SOCKET_MISSING", expected);
  const lexical = lstatSync(expected);
  const canonical = realpathSync(expected);
  const stats = lstatSync(canonical);
  validateRancherDesktopSocketMetadata({ canonicalPath: canonical, expectedPath: expected, isSocket: stats.isSocket(), isSymlink: lexical.isSymbolicLink(), ownerUid: stats.uid, expectedUid: currentUid(), mode: stats.mode });
  return `unix://${canonical}`;
}

export function productionRuntime() {
  const rancherCandidate = join(resolve(userInfo().homedir), ".rd", "bin", "docker");
  const useRancherDesktop = process.platform === "darwin" && existsSync(rancherCandidate);
  const dockerPath = useRancherDesktop
    ? resolveRancherDesktopDocker()
    : resolveTrustedTool(["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"], ["--version"], /^Docker version \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?, build [A-Za-z0-9._+-]+\s*$/);
  if (!dockerPath) reject("TRUSTED_TOOL_MISSING", "docker");
  const dockerEnvironment = useRancherDesktop ? { DOCKER_HOST: resolveRancherDesktopDockerHost() } : {};
  const docker = (args, accepted = [0]) => rawCommand(dockerPath, args, accepted, dockerEnvironment);
  return {
    docker,
    git: (args, _accepted, expectedImageId, expectedImageLabels, expectedImageEnvironment) => runGitProbe(docker, args, { expectedImageEnvironment, expectedImageId, expectedImageLabels }),
  };
}

function inspectOne(result, code) {
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1) reject(code, "inspect must return exactly one object");
    return values[0];
  } catch (error) { if (error instanceof FixtureError) throw error; reject(code, error.message); }
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isExactContainerNotFound(result, name) {
  const escaped = escapeRegExp(name);
  return result.status === 1 && new RegExp(`^(?:Error(?::| response from daemon:)?\\s*)?No such (?:object|container):?\\s*${escaped}\\s*$`, "i").test(result.stderr ?? "");
}
function isExactNotFound(result) { return isExactContainerNotFound(result, CONTAINER); }

export function gitProbeDockerArgs(args, nonce) {
  return [
    "create", "--rm", `--name=${PROBE_CONTAINER}`, "--network=kind", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--user=65534:65534", "--pull=never",
    "--label=com.schoolofdevops.course=agentic-iac-s10", "--label=com.schoolofdevops.fixture=git-probe",
    `--label=com.schoolofdevops.probe-nonce=${nonce}`,
    "--env=GIT_CONFIG=/dev/null", "--env=GIT_CONFIG_GLOBAL=/dev/null", "--env=GIT_CONFIG_NOSYSTEM=1",
    "--env=GIT_TERMINAL_PROMPT=0", "--env=HOME=/nonexistent",
    "--entrypoint=git", IMAGE, ...args,
  ];
}

const PROBE_ENVIRONMENT = ["GIT_CONFIG=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "HOME=/nonexistent"];
function environmentRecord(values) {
  if (!Array.isArray(values)) return undefined;
  const record = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) return undefined;
    const key = value.slice(0, separator);
    if (Object.hasOwn(record, key)) return undefined;
    record[key] = value.slice(separator + 1);
  }
  return record;
}
function expectedProbeEnvironment(imageEnvironment) {
  const record = environmentRecord(imageEnvironment);
  if (!record) return undefined;
  for (const value of PROBE_ENVIRONMENT) {
    const separator = value.indexOf("=");
    record[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return record;
}
function validateProbeContainer(container, expected) {
  const labels = container.Config?.Labels ?? {};
  const expectedLabels = { ...expected.imageLabels, "com.schoolofdevops.course": "agentic-iac-s10", "com.schoolofdevops.fixture": "git-probe", "com.schoolofdevops.probe-nonce": expected.nonce };
  const valid =
    container.Id === expected.containerId && /^[0-9a-f]{64}$/.test(container.Id ?? "") &&
    container.Image === expected.imageId && container.Name === `/${PROBE_CONTAINER}` && container.Config?.Image === IMAGE &&
    container.Config?.User === "65534:65534" && exactArray(container.Config?.Entrypoint, ["git"]) && exactArray(container.Config?.Cmd, expected.args) && exactRecord(environmentRecord(container.Config?.Env) ?? {}, expectedProbeEnvironment(expected.imageEnvironment) ?? { invalid: true }) &&
    exactRecord(labels, expectedLabels) &&
    container.HostConfig?.AutoRemove === true && container.HostConfig?.Privileged === false && container.HostConfig?.ReadonlyRootfs === true && exactArray(container.HostConfig?.CapDrop, ["ALL"]) &&
    (container.HostConfig?.CapAdd == null || exactArray(container.HostConfig.CapAdd, [])) && exactArray(container.HostConfig?.SecurityOpt, ["no-new-privileges"]) &&
    container.HostConfig?.NetworkMode === "kind" && Array.isArray(container.Mounts) && container.Mounts.length === 0 &&
    exactArray(Object.keys(container.NetworkSettings?.Networks ?? {}), ["kind"]);
  if (!valid) reject("GIT_PROBE_OWNERSHIP_MISMATCH", `refusing to remove unowned ${PROBE_CONTAINER}`);
}

function proveProbeNameAbsent(docker) {
  const byName = docker(["container", "inspect", PROBE_CONTAINER], [0, 1]);
  if (byName.status === 0) reject("GIT_PROBE_NAME_REUSED", `another container now owns ${PROBE_CONTAINER}`);
  if (!isExactContainerNotFound(byName, PROBE_CONTAINER)) reject("GIT_PROBE_ABSENCE_UNPROVEN", "Docker did not prove exact probe-name absence");
}

function removeCapturedProbe(docker, expected) {
  const immediatelyBeforeRemoval = docker(["container", "inspect", expected.containerId], [0, 1]);
  if (immediatelyBeforeRemoval.status === 0) {
    validateProbeContainer(inspectOne(immediatelyBeforeRemoval, "GIT_PROBE_OWNERSHIP_MISMATCH"), expected);
    docker(["rm", "-f", expected.containerId]);
  } else if (!isExactContainerNotFound(immediatelyBeforeRemoval, expected.containerId)) {
    reject("GIT_PROBE_ABSENCE_UNPROVEN", "Docker did not prove captured probe absence");
  }
  const capturedAfter = docker(["container", "inspect", expected.containerId], [0, 1]);
  if (!isExactContainerNotFound(capturedAfter, expected.containerId)) reject("GIT_PROBE_STILL_PRESENT", "Docker did not prove captured probe absence after cleanup");
  proveProbeNameAbsent(docker);
}

export function runGitProbe(docker, args, { expectedImageEnvironment = [], expectedImageId, expectedImageLabels = {}, nonce = randomBytes(32).toString("hex") } = {}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedImageId ?? "")) reject("GIT_PROBE_IMAGE_INVALID", "probe requires the inspected image ID");
  if (!/^[0-9a-f]{64}$/.test(nonce)) reject("GIT_PROBE_NONCE_INVALID", "probe nonce must be 256-bit lowercase hex");
  const before = docker(["container", "inspect", PROBE_CONTAINER], [0, 1]);
  if (!isExactContainerNotFound(before, PROBE_CONTAINER)) reject(before.status === 0 ? "GIT_PROBE_EXISTS" : "GIT_PROBE_ABSENCE_UNPROVEN", "refusing to create over an unknown probe state");
  let containerId;
  try {
    const created = docker(gitProbeDockerArgs(args, nonce));
    containerId = created.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(containerId)) reject("GIT_PROBE_ID_INVALID", "Docker create did not return a full container ID");
  } catch (error) {
    const uncertain = docker(["container", "inspect", PROBE_CONTAINER], [0, 1]);
    if (uncertain.status === 0) {
      const container = inspectOne(uncertain, "GIT_PROBE_OWNERSHIP_MISMATCH");
      containerId = container.Id;
      const expected = { args, containerId, imageEnvironment: expectedImageEnvironment, imageId: expectedImageId, imageLabels: expectedImageLabels, nonce };
      validateProbeContainer(container, expected);
      removeCapturedProbe(docker, expected);
    } else if (!isExactContainerNotFound(uncertain, PROBE_CONTAINER)) {
      reject("GIT_PROBE_ABSENCE_UNPROVEN", "Docker did not prove probe absence after create failed");
    }
    throw error;
  }
  const expected = { args, containerId, imageEnvironment: expectedImageEnvironment, imageId: expectedImageId, imageLabels: expectedImageLabels, nonce };
  const createdResult = docker(["container", "inspect", containerId], [0, 1]);
  if (createdResult.status !== 0) {
    if (isExactContainerNotFound(createdResult, containerId)) {
      proveProbeNameAbsent(docker);
      reject("GIT_PROBE_DISAPPEARED", "captured probe disappeared before validation");
    }
    reject("GIT_PROBE_ABSENCE_UNPROVEN", "Docker did not return the captured probe for validation");
  }
  const createdContainer = inspectOne(createdResult, "GIT_PROBE_OWNERSHIP_MISMATCH");
  validateProbeContainer(createdContainer, expected);
  let result;
  let commandError;
  try {
    result = docker(["start", "--attach", containerId], Array.from({ length: 256 }, (_, code) => code));
  } catch (error) {
    commandError = error;
  }
  removeCapturedProbe(docker, expected);
  if (commandError) throw commandError;
  return result;
}

export function removeContainerAndProveAbsent(runtime) {
  runtime.docker(["rm", "-f", CONTAINER]);
  const after = runtime.docker(["container", "inspect", CONTAINER], [0, 1]);
  if (!isExactNotFound(after)) reject("CONTAINER_STILL_PRESENT", "docker did not prove exact container absence after rm");
}

function validateImage(runtime) {
  const image = inspectOne(runtime.docker(["image", "inspect", IMAGE]), "GIT_IMAGE_INVALID");
  if (
    !/^sha256:[0-9a-f]{64}$/.test(image.Id ?? "") ||
    !Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(IMAGE) ||
    !["amd64", "arm64"].includes(image.Architecture) ||
    !exactArray(image.Config?.Entrypoint, ["/opt/bitnami/scripts/git/entrypoint.sh"]) ||
    !exactArray(image.Config?.Cmd, ["/bin/bash"]) ||
    image.Config?.WorkingDir !== "/" ||
    ![undefined, ""].includes(image.Config?.User) ||
    image.Config?.Volumes !== undefined
  ) reject("GIT_IMAGE_INVALID", "pinned image digest or frozen image config is invalid");
  return { environment: image.Config?.Env ?? [], id: image.Id, labels: image.Config?.Labels ?? {} };
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
    const probe = runtime.git(["ls-remote", endpoint, "refs/heads/main"], [0, 1], image.id, image.labels, image.environment);
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

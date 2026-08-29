#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const TASK_ID = "section-10-task-4";
const CONTAINER = "agentic-iac-s10-git";
const CLUSTER_NODE = "agentic-iac-s10-control-plane";
const IMAGE = "alpine/git@sha256:6f8eae2205a85c51106a9650e574a37fb1d5e4f645e5f6ea57cb57b9462cd4cf";
const MARKER_NAME = ".agentic-iac-s10-git-mirror.json";
const READY_NAME = "git-mirror-ready.json";

class FixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function reject(code, message) { throw new FixtureError(code, message); }
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    reject("USAGE", `missing ${name}`);
  }
  if (index === process.argv.length - 1) reject("USAGE", `missing value for ${name}`);
  return process.argv[index + 1];
}
function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (index === process.argv.length - 1) reject("USAGE", `missing value for ${name}`);
  return process.argv[index + 1];
}
function findTool(candidates, label) {
  for (const candidate of candidates) if (existsSync(candidate)) return realpathSync(candidate);
  reject("TOOL_MISSING", label);
}
function validateTool(input, label) {
  const path = resolve(input);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || (statSync(path).mode & 0o111) === 0) {
    reject("TOOL_INVALID", label);
  }
  return realpathSync(path);
}
function command(executable, args, accepted = [0]) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    env: { HOME: realpathSync(tmpdir()), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (!accepted.includes(result.status)) reject("COMMAND_FAILED", result.error?.message ?? result.stderr ?? result.stdout);
  return result;
}
function parseInspect(result, code) {
  try {
    const value = JSON.parse(result.stdout);
    if (!Array.isArray(value) || value.length !== 1) reject(code, "inspect must return exactly one object");
    return value[0];
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    reject(code, error.message);
  }
}
function loadMarker(rootInput) {
  const requested = resolve(rootInput);
  const temp = realpathSync(tmpdir());
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) reject("ROOT_INVALID", requested);
  const root = realpathSync(requested);
  if (dirname(root) !== temp || !basename(root).startsWith("agentic-iac-s10-")) reject("ROOT_OUTSIDE_TEMP", root);
  const markerPath = join(root, MARKER_NAME);
  if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink() || !statSync(markerPath).isFile()) reject("OWNERSHIP_MARKER", markerPath);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (marker.task_id !== TASK_ID || marker.root !== root || marker.repository_name !== "delivery.git" || !/^[0-9a-f]{40}$/.test(marker.source_revision ?? "")) {
    reject("OWNERSHIP_MARKER", "marker fields do not match this fixture");
  }
  const repository = join(root, marker.repository_name);
  if (!existsSync(repository) || lstatSync(repository).isSymbolicLink() || realpathSync(repository) !== repository) reject("MIRROR_INVALID", repository);
  if (existsSync(join(root, READY_NAME))) reject("MIRROR_ALREADY_STARTED", root);
  return { root, marker, repository };
}

let created = false;
let docker;
try {
  const { root, marker, repository } = loadMarker(argument("--root"));
  docker = validateTool(optionalArgument("--docker-path") ?? findTool(["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"], "docker"), "docker");
  const git = validateTool(optionalArgument("--git-path") ?? findTool(["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"], "git"), "git");
  const network = command(docker, ["network", "inspect", "kind"], [0, 1]);
  if (network.status !== 0) reject("KIND_NETWORK_MISSING", "Docker network kind does not exist");
  const nodeResult = command(docker, ["container", "inspect", CLUSTER_NODE], [0, 1]);
  if (nodeResult.status !== 0) reject("SECTION10_CLUSTER_MISSING", `required node ${CLUSTER_NODE} does not exist`);
  const node = parseInspect(nodeResult, "SECTION10_CLUSTER_INVALID");
  if (node.Config?.Labels?.["io.x-k8s.kind.cluster"] !== "agentic-iac-s10" || !node.NetworkSettings?.Networks?.kind) {
    reject("SECTION10_CLUSTER_INVALID", "the exact Section 10 Kind node must own the kind-network precondition");
  }
  const existing = command(docker, ["container", "inspect", CONTAINER], [0, 1]);
  if (existing.status === 0) reject("GIT_CONTAINER_EXISTS", `refusing to replace ${CONTAINER}`);
  const run = command(docker, [
    "run", "-d",
    `--name=${CONTAINER}`,
    "--network=kind",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--label=com.schoolofdevops.course=agentic-iac-s10",
    "--label=com.schoolofdevops.fixture=git-mirror",
    `--label=com.schoolofdevops.source-revision=${marker.source_revision}`,
    `--mount=type=bind,src=${repository},dst=/git/delivery.git,readonly`,
    "--entrypoint=git",
    IMAGE,
    "daemon", "--reuseaddr", "--verbose", "--export-all", "--base-path=/git", "--port=9418", "--listen=0.0.0.0",
    "--enable=upload-pack", "--disable=receive-pack", "--disable=upload-archive", "/git/delivery.git",
  ]);
  created = true;
  const containerId = run.stdout.trim();
  const inspected = parseInspect(command(docker, ["inspect", CONTAINER]), "GIT_CONTAINER_INVALID");
  if (inspected.Id !== containerId || inspected.Config?.Labels?.["com.schoolofdevops.course"] !== "agentic-iac-s10" || inspected.Config?.Labels?.["com.schoolofdevops.fixture"] !== "git-mirror" || inspected.Config?.Labels?.["com.schoolofdevops.source-revision"] !== marker.source_revision) {
    reject("GIT_CONTAINER_INVALID", "container identity or ownership labels changed");
  }
  const ip = inspected.NetworkSettings?.Networks?.kind?.IPAddress;
  if (typeof ip !== "string" || !ip) reject("GIT_CONTAINER_INVALID", "kind-network IP is missing");
  const endpoint = `git://${ip}:9418/delivery.git`;
  const probe = command(git, ["ls-remote", endpoint, "refs/heads/main"], [0, 1]);
  const expected = `${marker.source_revision}\trefs/heads/main`;
  if (probe.status !== 0 || probe.stdout.trim() !== expected) reject("REVISION_PROBE_FAILED", probe.stderr || `${probe.stdout.trim()} != ${expected}`);
  const ready = {
    task_id: TASK_ID,
    container_name: CONTAINER,
    container_id: containerId,
    repository_name: "delivery.git",
    source_revision: marker.source_revision,
    endpoint,
    transport_scope: "anonymous local course transport; not production authentication or authorization",
  };
  writeFileSync(join(root, READY_NAME), `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o400, flag: "wx" });
  process.stdout.write(`${JSON.stringify(ready)}\n`);
} catch (error) {
  if (created && docker) spawnSync(docker, ["rm", "-f", CONTAINER], { encoding: "utf8", shell: false, env: { HOME: realpathSync(tmpdir()), PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  const code = error instanceof FixtureError ? error.code : "UNEXPECTED";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exitCode = 1;
}

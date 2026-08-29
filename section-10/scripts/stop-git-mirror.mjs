#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const TASK_ID = "section-10-task-4";
const CONTAINER = "agentic-iac-s10-git";
const MARKER_NAME = ".agentic-iac-s10-git-mirror.json";
const READY_NAME = "git-mirror-ready.json";

class FixtureError extends Error { constructor(code, message) { super(message); this.code = code; } }
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
function findDocker() {
  for (const candidate of ["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"]) if (existsSync(candidate)) return realpathSync(candidate);
  reject("TOOL_MISSING", "docker");
}
function validateDocker(input) {
  const path = resolve(input);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || (statSync(path).mode & 0o111) === 0) reject("TOOL_INVALID", "docker");
  return realpathSync(path);
}
function command(docker, args, accepted = [0]) {
  const result = spawnSync(docker, args, { encoding: "utf8", shell: false, env: { HOME: realpathSync(tmpdir()), PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 60_000, killSignal: "SIGKILL" });
  if (!accepted.includes(result.status)) reject("DOCKER_COMMAND_FAILED", result.error?.message ?? result.stderr ?? result.stdout);
  return result;
}
function readPlainFile(path, code) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) reject(code, path);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { reject(code, error.message); }
}

try {
  const requested = resolve(argument("--root"));
  const temp = realpathSync(tmpdir());
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) reject("ROOT_OUTSIDE_TEMP", requested);
  const root = realpathSync(requested);
  if (dirname(root) !== temp || !basename(root).startsWith("agentic-iac-s10-")) {
    reject("ROOT_OUTSIDE_TEMP", requested);
  }
  const marker = readPlainFile(join(root, MARKER_NAME), "OWNERSHIP_MARKER");
  if (marker.task_id !== TASK_ID || marker.root !== root || marker.repository_name !== "delivery.git" || !/^[0-9a-f]{40}$/.test(marker.source_revision ?? "")) {
    reject("OWNERSHIP_MARKER", "marker fields do not match this fixture");
  }
  const docker = validateDocker(optionalArgument("--docker-path") ?? findDocker());
  const inspected = command(docker, ["container", "inspect", CONTAINER], [0, 1]);
  let removedContainer = false;
  if (inspected.status === 0) {
    let container;
    try { [container] = JSON.parse(inspected.stdout); } catch (error) { reject("CONTAINER_OWNERSHIP_MISMATCH", error.message); }
    if (!container || container.Config?.Labels?.["com.schoolofdevops.course"] !== "agentic-iac-s10" || container.Config?.Labels?.["com.schoolofdevops.fixture"] !== "git-mirror" || container.Config?.Labels?.["com.schoolofdevops.source-revision"] !== marker.source_revision) {
      reject("CONTAINER_OWNERSHIP_MISMATCH", `refusing to remove unowned ${CONTAINER}`);
    }
    const ready = readPlainFile(join(root, READY_NAME), "OWNERSHIP_MARKER");
    if (ready.container_id !== container.Id || ready.source_revision !== marker.source_revision) {
      reject("CONTAINER_OWNERSHIP_MISMATCH", `refusing to remove unowned ${CONTAINER}`);
    }
    command(docker, ["rm", "-f", CONTAINER]);
    removedContainer = true;
  }
  rmSync(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ task_id: TASK_ID, container_name: CONTAINER, container_removed: removedContainer, mirror_removed: true })}\n`);
} catch (error) {
  const code = error instanceof FixtureError ? error.code : "UNEXPECTED";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exitCode = 1;
}

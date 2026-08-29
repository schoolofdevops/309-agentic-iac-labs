#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FixtureError, loadMirrorState, parseCliArgs, reject } from "./prepare-git-mirror.mjs";
import { CONTAINER, productionRuntime, removeContainerAndProveAbsent } from "./start-git-mirror.mjs";

function isExactNotFound(result) { return result.status === 1 && /No such (?:object|container):?\s*agentic-iac-s10-git/i.test(result.stderr ?? ""); }
function inspectOne(result) {
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1) reject("CONTAINER_OWNERSHIP_MISMATCH", "inspect must return exactly one object");
    return values[0];
  } catch (error) { if (error instanceof FixtureError) throw error; reject("CONTAINER_OWNERSHIP_MISMATCH", error.message); }
}

export function stopGitMirror({ rootInput, runtime }) {
  const owned = loadMirrorState(rootInput);
  const inspected = runtime.docker(["container", "inspect", CONTAINER], [0, 1]);
  let containerRemoved = false;
  if (owned.lifecycle === "PREPARED") {
    if (!isExactNotFound(inspected)) reject(inspected.status === 0 ? "CONTAINER_WITHOUT_READY" : "CONTAINER_ABSENCE_UNPROVEN", "prepared cleanup requires proved exact container absence");
  } else {
    if (inspected.status !== 0) reject("READY_CONTAINER_MISSING", "READY cleanup requires the exact running container");
    const container = inspectOne(inspected);
    const endpoint = `git://${container.NetworkSettings?.Networks?.kind?.IPAddress ?? ""}:9418/delivery.git`;
    if (owned.ready.endpoint !== endpoint) reject("READY_RECORD_INVALID", "ready endpoint does not match the owned container network IP");
    if (container.Id !== owned.ready.container_id || container.Config?.Labels?.["com.schoolofdevops.course"] !== "agentic-iac-s10" || container.Config?.Labels?.["com.schoolofdevops.fixture"] !== "git-mirror" || container.Config?.Labels?.["com.schoolofdevops.source-revision"] !== owned.marker.source_revision) reject("CONTAINER_OWNERSHIP_MISMATCH", `refusing to remove unowned ${CONTAINER}`);
    removeContainerAndProveAbsent(runtime);
    containerRemoved = true;
  }
  // Recompute the complete lifecycle and repository inventory immediately before deletion.
  loadMirrorState(owned.root, { require: owned.lifecycle });
  rmSync(owned.root, { recursive: true, force: true });
  if (existsSync(owned.root)) reject("MIRROR_REMOVAL_UNPROVEN", owned.root);
  return { task_id: "section-10-task-4", container_name: CONTAINER, container_removed: containerRemoved, mirror_removed: true };
}

function isMain() { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; }
if (isMain()) {
  try {
    const args = parseCliArgs(process.argv.slice(2), ["--root"]);
    process.stdout.write(`${JSON.stringify(stopGitMirror({ rootInput: args["--root"], runtime: productionRuntime() }))}\n`);
  } catch (error) { process.stderr.write(`${error instanceof FixtureError ? error.code : "UNEXPECTED"}: ${error.message}\n`); process.exitCode = 1; }
}

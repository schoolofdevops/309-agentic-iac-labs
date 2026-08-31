#!/usr/bin/env node

import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadMirrorState } from "./prepare-git-mirror.mjs";
import { EXACT, helmUninstallArgs } from "./run-gitops-lifecycle.mjs";

export async function cleanupOwnedLifecycle(rootInput, options = {}) {
  const requested = resolve(rootInput);
  if (lstatSync(requested).isSymbolicLink()) throw new Error("SYMLINK_MARKER_FORBIDDEN");
  const root = realpathSync(requested);
  const loadState = options.loadState ?? ((value) => loadMirrorState(value, { require: "READY" }));
  const state = loadState(root);
  if (state.lifecycle !== "READY" || state.root !== root || state.ready?.container_name !== EXACT.gitContainer) throw new Error("OWNERSHIP_MARKER_INVALID");
  const execute = options.execute;
  if (!execute) throw new Error("EXECUTOR_REQUIRED");
  for (const [tool, args] of [
    ["kubectl", ["--context", EXACT.context, "-n", EXACT.argocdNamespace, "delete", "application", EXACT.application, "--ignore-not-found=true"]],
    ["helm", helmUninstallArgs()],
    ["kubectl", ["--context", EXACT.context, "delete", "namespace", EXACT.workloadNamespace, "--ignore-not-found=true"]],
    ["kubectl", ["--context", EXACT.context, "delete", "namespace", EXACT.argocdNamespace, "--ignore-not-found=true"]],
  ]) await execute(tool, args);
  return { status: "EXACT_RESOURCES_REQUESTED_FOR_REMOVAL", root };
}

function isMain() { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; }
if (isMain()) {
  console.error("ERROR: cleanup-gitops.mjs is called by the trusted lifecycle runner");
  process.exitCode = 2;
}

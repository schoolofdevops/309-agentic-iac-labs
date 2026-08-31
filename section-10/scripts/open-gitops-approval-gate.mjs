#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { EXACT, openApprovalGate } from "./run-gitops-lifecycle.mjs";

const PROMOTION_PATH = "section-10/starter/gitops/chart/values.yaml";
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
  "-c", "diff.external=", "-c", "protocol.file.allow=always",
];
const PURPOSES = new Set(["promote-v2", "revert-and-recover"]);

function fail(code, detail = "") { throw new Error(`${code}${detail ? `: ${detail}` : ""}`); }
function isRevision(value) { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }

function trustedTool(name) {
  const candidates = name === "git"
    ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    : ["/opt/homebrew/bin/kubectl", "/usr/local/bin/kubectl", "/usr/bin/kubectl"];
  const currentUid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const executable = realpathSync(candidate);
    const metadata = statSync(executable);
    if (metadata.isFile() && (metadata.mode & 0o111) !== 0 && (metadata.mode & 0o022) === 0 && [0, currentUid].includes(metadata.uid)) return executable;
  }
  fail("TRUSTED_TOOL_MISSING", name);
}

function command(executable, args, { cwd, env = {}, accepted = [0], timeout = 30_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout,
    env: { ...process.env, LANG: "C", LC_ALL: "C", PAGER: "cat", ...env },
  });
  if (!accepted.includes(result.status)) fail("EVIDENCE_COMMAND_FAILED", result.stderr.trim() || result.stdout.trim() || `${executable} exited ${result.status}`);
  return result.stdout.trim();
}

function productionGit(source, args) {
  return command(trustedTool("git"), ["-C", source, ...SAFE_GIT_CONFIG, ...args], {
    env: {
      GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXTERNAL_DIFF: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat", GIT_PROTOCOL_FROM_USER: "0", GIT_SSH_COMMAND: "/usr/bin/false", GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function productionKube(args) {
  return command(trustedTool("kubectl"), args, { timeout: 30_000 });
}

function parseArgs(argv) {
  const allowed = ["--source", "--revision", "--approval", "--purpose"];
  const values = {};
  if (argv.length !== allowed.length * 2) fail("USAGE");
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key) || typeof value !== "string" || value.startsWith("--") || Object.hasOwn(values, key)) fail("USAGE");
    values[key] = value;
  }
  if (allowed.some((key) => !Object.hasOwn(values, key))) fail("USAGE");
  return { source: values["--source"], revision: values["--revision"], approval: values["--approval"], purpose: values["--purpose"] };
}

function commitRecord(source, revision, gitRun) {
  if (!isRevision(revision) || gitRun(source, ["cat-file", "-t", revision]) !== "commit") fail("REVISION_INVALID", revision);
  const raw = gitRun(source, ["cat-file", "commit", revision]);
  const headers = raw.split("\n\n", 1)[0].split("\n");
  const tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (!isRevision(tree) || parents.some((parent) => !isRevision(parent))) fail("COMMIT_OBJECT_INVALID", revision);
  return { revision, tree, parents };
}

function applicationEvidence(kubeRun) {
  let application;
  try {
    application = JSON.parse(kubeRun([
      "--context", EXACT.context, "-n", EXACT.argocdNamespace, "get", "application", EXACT.application, "-o", "json",
    ]));
  } catch (error) {
    if (/^[A-Z_]+/.test(error?.message ?? "")) throw error;
    fail("APPLICATION_EVIDENCE_INVALID", error.message);
  }
  if (application?.apiVersion !== "argoproj.io/v1alpha1" || application?.kind !== "Application"
    || application?.metadata?.name !== EXACT.application || application?.metadata?.namespace !== EXACT.argocdNamespace
    || application?.spec?.source?.repoURL !== `git://${EXACT.gitContainer}:9418/delivery.git`
    || application?.spec?.source?.targetRevision !== "HEAD"
    || application?.spec?.source?.path !== "section-10/starter/gitops/chart"
    || application?.spec?.syncPolicy?.automated !== undefined) fail("APPLICATION_CONTRACT_INVALID");
  return application;
}

function deploymentReplicas(kubeRun) {
  let deployment;
  try {
    deployment = JSON.parse(kubeRun([
      "--context", EXACT.context, "-n", EXACT.workloadNamespace, "get", "deployment", "inference-platform-api", "-o", "json",
    ]));
  } catch (error) {
    if (/^[A-Z_]+/.test(error?.message ?? "")) throw error;
    fail("WORKLOAD_EVIDENCE_INVALID", error.message);
  }
  if (deployment?.apiVersion !== "apps/v1" || deployment?.kind !== "Deployment"
    || deployment?.metadata?.name !== "inference-platform-api" || deployment?.metadata?.namespace !== EXACT.workloadNamespace
    || deployment?.spec?.replicas !== 2) fail("DRIFT_EVIDENCE_INVALID");
  return deployment.spec.replicas;
}

function assertCleanSource(source, gitRun) {
  const status = gitRun(source, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") fail("DELIVERY_REPOSITORY_DIRTY", status);
}

function assertPromotionCommit(source, candidate, currentRevision, gitRun) {
  if (candidate.parents.length !== 1 || candidate.parents[0] !== currentRevision) fail("PROMOTION_NOT_DIRECT_SUCCESSOR");
  const current = commitRecord(source, currentRevision, gitRun);
  if (candidate.tree === current.tree) fail("PROMOTION_TREE_UNCHANGED");
  const paths = gitRun(source, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", `${currentRevision}..${candidate.revision}`, "--"])
    .split("\n").filter(Boolean);
  if (JSON.stringify(paths) !== JSON.stringify([PROMOTION_PATH])) fail("PROMOTION_SCOPE_INVALID", paths.join(","));
  const before = gitRun(source, ["show", `${currentRevision}:${PROMOTION_PATH}`]);
  const after = gitRun(source, ["show", `${candidate.revision}:${PROMOTION_PATH}`]);
  if (!/^\s*tag:\s+s10-v1\s*$/m.test(before) || !/^\s*tag:\s+s10-v2\s*$/m.test(after)) fail("PROMOTION_IMAGE_INVALID");
}

function assertRecoveryCommit(source, recovery, currentRevision, gitRun) {
  if (recovery.parents.length !== 1 || recovery.parents[0] !== currentRevision) fail("RECOVERY_NOT_DIRECT_SUCCESSOR");
  const current = commitRecord(source, currentRevision, gitRun);
  if (current.parents.length !== 1) fail("RECOVERY_LINEAGE_INVALID");
  const previous = commitRecord(source, current.parents[0], gitRun);
  if (recovery.tree !== previous.tree || recovery.tree === current.tree) fail("RECOVERY_TREE_MISMATCH");
  const paths = gitRun(source, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", `${currentRevision}..${recovery.revision}`, "--"])
    .split("\n").filter(Boolean);
  if (JSON.stringify(paths) !== JSON.stringify([PROMOTION_PATH])) fail("RECOVERY_SCOPE_INVALID", paths.join(","));
}

export async function openLearnerApprovalGate(input, {
  gitRun = productionGit,
  kubeRun = productionKube,
  sleep = delay,
  driftObservationMs = 15_000,
  openGate = openApprovalGate,
} = {}) {
  if (!PURPOSES.has(input.purpose) || !isRevision(input.revision)) fail("INPUT_INVALID");
  const requested = resolve(input.source);
  if (lstatSync(requested).isSymbolicLink()) fail("SOURCE_SYMLINK_FORBIDDEN");
  const source = realpathSync(requested);
  const approval = resolve(input.approval);
  if (existsSync(approval) || existsSync(`${approval}.gate.json`)) fail("PREEXISTING_APPROVAL_STATE");
  assertCleanSource(source, gitRun);
  if (gitRun(source, ["rev-parse", "HEAD"]) !== input.revision) fail("REVISION_NOT_HEAD");
  const candidate = commitRecord(source, input.revision, gitRun);
  const application = applicationEvidence(kubeRun);
  const currentRevision = application.status?.sync?.revision;
  if (!isRevision(currentRevision) || currentRevision === input.revision) fail("APPLICATION_REVISION_INVALID");

  let observed;
  if (input.purpose === "promote-v2") {
    if (application.status?.sync?.status !== "Synced" || application.status?.health?.status !== "Healthy"
      || application.status?.operationState?.phase !== "Succeeded") fail("PROMOTION_STATE_INVALID");
    assertPromotionCommit(source, candidate, currentRevision, gitRun);
    observed = { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: currentRevision };
  } else {
    if (application.status?.sync?.status !== "OutOfSync") fail("RECOVERY_STATE_INVALID");
    assertRecoveryCommit(source, candidate, currentRevision, gitRun);
    deploymentReplicas(kubeRun);
    await sleep(driftObservationMs);
    const confirmed = applicationEvidence(kubeRun);
    if (confirmed.status?.sync?.status !== "OutOfSync" || confirmed.status?.sync?.revision !== currentRevision) fail("DRIFT_DID_NOT_PERSIST");
    const replicas = deploymentReplicas(kubeRun);
    observed = { sync: "OutOfSync", replicas_after_15_seconds: replicas };
  }

  const gate = openGate(approval, input.revision, input.purpose, observed);
  return { approval, gate: gate.binding.path, observed, purpose: input.purpose, revision: input.revision };
}

async function main() {
  try {
    const result = await openLearnerApprovalGate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Approval gate opened for ${result.revision} (${result.purpose}).\n`);
    process.stdout.write(`Gate: ${result.gate}\n`);
  } catch (error) {
    const code = /^[A-Z_]+/.test(error?.message ?? "") ? error.message : `GATE_OPEN_FAILED: ${error.message}`;
    process.stderr.write(`Approval gate not opened: ${code}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID = "section-10-task-2";
const WORKFLOW_RELATIVE_PATH = "section-10/workflows/terraform-plan.yml";
const TERRAFORM_RELATIVE_PATH = "section-10/terraform";
const ENGINE = {
  terraform: { executable: "terraform", version: "1.14.8" },
  opentofu: { executable: "tofu", version: "1.12.6" },
};

class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reject(code, message) {
  throw new GuardError(code, message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) reject("USAGE", `missing ${name}`);
  return process.argv[index + 1];
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixedCommand(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, TF_IN_AUTOMATION: "true", CHECKPOINT_DISABLE: "1" },
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0) {
    reject("COMMAND_FAILED", `${executable} ${args[0]} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function assertNoSymlinks(root) {
  if (lstatSync(root).isSymbolicLink()) reject("SYMLINK_FORBIDDEN", root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (lstatSync(path).isSymbolicLink()) reject("SYMLINK_FORBIDDEN", path);
    if (entry.isDirectory()) assertNoSymlinks(path);
  }
}

function validateTerraformSource(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !(entry.name.endsWith(".tf") || entry.name.endsWith(".tftest.hcl"))) {
      reject("UNEXPECTED_TERRAFORM_SOURCE", entry.name);
    }
    const path = join(root, entry.name);
    const source = readFileSync(path, "utf8");
    if (/\brequired_providers\b|\bprovider\s+"/.test(source)) reject("PROVIDER_FORBIDDEN", entry.name);
    if (/\bbackend\s+"|\bcloud\s*\{/.test(source)) reject("BACKEND_FORBIDDEN", entry.name);
    if (/https?:\/\//.test(source)) reject("NETWORK_SOURCE_FORBIDDEN", entry.name);
    if (/\bmodule\s+"/.test(source)) reject("MODULE_FORBIDDEN", entry.name);
    if (/\b(?:credential|access_key|secret_key|token)\s*=/.test(source)) reject("CREDENTIAL_FORBIDDEN", entry.name);
    for (const match of source.matchAll(/\bresource\s+"([^"]+)"/g)) {
      if (match[1] !== "terraform_data") reject("RESOURCE_TYPE_FORBIDDEN", match[1]);
    }
    files.push(entry.name);
  }
  return files.sort();
}

function assertOutputPath(output) {
  const temporaryRoot = resolve(tmpdir());
  const canonicalTemporaryRoot = realpathSync(temporaryRoot);
  const absolute = resolve(output);
  if (absolute === temporaryRoot || !absolute.startsWith(`${temporaryRoot}${sep}`)) {
    reject("OUTPUT_OUTSIDE_TEMP", absolute);
  }
  if (!basename(absolute).startsWith("agentic-iac-s10-")) {
    reject("OUTPUT_PREFIX", "evidence directory must use the agentic-iac-s10- prefix");
  }
  if (existsSync(absolute)) reject("OUTPUT_EXISTS", absolute);
  let cursor = dirname(absolute);
  while (cursor.startsWith(`${temporaryRoot}${sep}`)) {
    if (lstatSync(cursor).isSymbolicLink()) reject("OUTPUT_SYMLINK", cursor);
    if (cursor === temporaryRoot) break;
    cursor = dirname(cursor);
  }
  const expectedCanonicalParent = join(canonicalTemporaryRoot, relative(temporaryRoot, dirname(absolute)));
  if (realpathSync(dirname(absolute)) !== expectedCanonicalParent) reject("OUTPUT_SYMLINK", dirname(absolute));
  return absolute;
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    reject("MANIFEST_INVALID", error.message);
  }
}

function gitHead(source) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8", shell: false });
  if (result.status !== 0) reject("SOURCE_NOT_GIT", result.stderr);
  return result.stdout.trim();
}

function assertReviewedSourceClean(source) {
  const result = spawnSync("git", [
    "status", "--porcelain", "--untracked-files=all", "--",
    TERRAFORM_RELATIVE_PATH, WORKFLOW_RELATIVE_PATH,
  ], { cwd: source, encoding: "utf8", shell: false });
  if (result.status !== 0) reject("SOURCE_NOT_GIT", result.stderr);
  if (result.stdout.trim()) reject("DIRTY_SOURCE", "reviewed Terraform or workflow bytes are not committed at HEAD");
}

function validateChange(manifest, source, workflowPath) {
  if (manifest.task_id !== TASK_ID) reject("TASK_ID_MISMATCH", "unexpected task_id");
  if (!/^[0-9a-f]{40}$/.test(manifest.source_revision ?? "") || manifest.source_revision !== gitHead(source)) {
    reject("STALE_SOURCE_REVISION", "manifest is not bound to current Git HEAD");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.workflow_sha256 ?? "") || manifest.workflow_sha256 !== hashFile(workflowPath)) {
    reject("WORKFLOW_HASH_MISMATCH", "safe workflow bytes changed after review");
  }
  if (typeof manifest.proposer !== "string" || typeof manifest.approver !== "string" || !manifest.proposer || !manifest.approver) {
    reject("APPROVAL_IDENTITY", "proposer and approver are required");
  }
  if (manifest.proposer === manifest.approver) reject("SELF_APPROVAL", "the proposer cannot approve its own change");
  if (!Array.isArray(manifest.changed_files) || manifest.changed_files.length === 0) {
    reject("CHANGED_FILES_REQUIRED", "candidate manifest has no changed files");
  }
  for (const changed of manifest.changed_files) {
    if (typeof changed !== "string" || isAbsolute(changed)) reject("SOURCE_ESCAPE", String(changed));
    const resolved = resolve(source, changed);
    if (!resolved.startsWith(`${source}${sep}`)) reject("SOURCE_ESCAPE", changed);
    const normalized = changed.replaceAll("\\", "/");
    if (normalized === WORKFLOW_RELATIVE_PATH || /(^|\/)\.github\/workflows\//.test(normalized) || /(^|\/)workflows\/[^/]+\.ya?ml$/.test(normalized)) {
      reject("WORKFLOW_IMMUTABLE", changed);
    }
  }
}

function engineVersion(profile) {
  const raw = fixedCommand(profile.executable, ["version", "-json"], process.cwd());
  const version = JSON.parse(raw).terraform_version;
  if (version !== profile.version) reject("ENGINE_VERSION_MISMATCH", `expected ${profile.version}, got ${version}`);
  return version;
}

function main() {
  let output;
  let createdOutput = false;
  try {
    const engineName = argument("--engine");
    const profile = ENGINE[engineName];
    if (!profile) reject("UNKNOWN_ENGINE", "accepted values are exactly terraform and opentofu");
    const sourceInput = argument("--source");
    if (lstatSync(sourceInput).isSymbolicLink()) reject("SYMLINK_FORBIDDEN", sourceInput);
    const source = realpathSync(sourceInput);
    const terraformSource = join(source, TERRAFORM_RELATIVE_PATH);
    const workflowPath = join(source, WORKFLOW_RELATIVE_PATH);
    assertNoSymlinks(terraformSource);
    const terraformFiles = validateTerraformSource(terraformSource);
    assertNoSymlinks(dirname(workflowPath));
    const manifestPath = argument("--manifest");
    if (lstatSync(manifestPath).isSymbolicLink()) reject("SYMLINK_FORBIDDEN", manifestPath);
    const manifest = readManifest(manifestPath);
    assertReviewedSourceClean(source);
    validateChange(manifest, source, workflowPath);

    const checker = join(dirname(fileURLToPath(import.meta.url)), "check-delivery-change.mjs");
    fixedCommand(process.execPath, [checker, "--workflow", workflowPath], source);
    const version = engineVersion(profile);
    output = assertOutputPath(argument("--output"));
    const canonicalOutput = join(realpathSync(tmpdir()), relative(resolve(tmpdir()), output));
    if (canonicalOutput.startsWith(`${source}${sep}`)) reject("OUTPUT_IN_SOURCE", "evidence cannot be written inside reviewed Git source");
    mkdirSync(output, { mode: 0o700 });
    createdOutput = true;
    writeFileSync(join(output, ".agentic-iac-s10-evidence-root"), `${TASK_ID}\n`, { mode: 0o600 });

    const workingDirectory = join(output, "work", "terraform");
    mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
    for (const name of terraformFiles) cpSync(join(terraformSource, name), join(workingDirectory, name));
    fixedCommand(profile.executable, ["fmt", "-check", "-recursive"], workingDirectory);
    fixedCommand(profile.executable, ["init", "-backend=false", "-input=false", "-no-color"], workingDirectory);
    fixedCommand(profile.executable, ["validate", "-no-color"], workingDirectory);
    fixedCommand(profile.executable, ["test", "-no-color"], workingDirectory);

    const planPath = join(output, "reviewed.tfplan");
    fixedCommand(profile.executable, ["plan", "-input=false", "-lock=false", "-no-color", `-out=${planPath}`], workingDirectory);
    const planJsonPath = join(output, "reviewed-plan.json");
    writeFileSync(planJsonPath, fixedCommand(profile.executable, ["show", "-json", planPath], workingDirectory), { mode: 0o600 });
    const planJson = JSON.parse(readFileSync(planJsonPath, "utf8"));
    const resourceAddresses = [...new Set((planJson.resource_changes ?? []).map((change) => change.address))].sort();
    if (resourceAddresses.length === 0) reject("EMPTY_PLAN", "accepted evidence must name reviewed resources");

    const report = {
      task_id: TASK_ID,
      source_revision: manifest.source_revision,
      engine: engineName,
      engine_version: version,
      workflow_sha256: hashFile(workflowPath),
      plan_sha256: hashFile(planPath),
      plan_json_sha256: hashFile(planJsonPath),
      resource_addresses: resourceAddresses,
      gate_results: {
        format: "PASS",
        init_backend_disabled: "PASS",
        validate: "PASS",
        tests: "PASS",
        plan: "PASS",
        plan_json: "PASS",
        workflow_contract: "PASS",
        change_contract: "PASS",
      },
      apply_permitted: false,
    };
    writeFileSync(join(output, "plan-evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`READY_FOR_HUMAN_REVIEW ${join(output, "plan-evidence.json")}\n`);
  } catch (error) {
    if (createdOutput && output && existsSync(output)) rmSync(output, { recursive: true, force: true });
    const code = error instanceof GuardError ? error.code : "RUNNER_ERROR";
    process.stderr.write(`REJECTED ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();

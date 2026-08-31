#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID = "section-10-task-2";
const WORKFLOW_RELATIVE_PATH = "section-10/workflows/terraform-plan.yml";
const TERRAFORM_RELATIVE_PATH = "section-10/terraform";
const CHECKER_RELATIVE_PATH = "section-10/scripts/check-delivery-change.mjs";
const RUNNER_RELATIVE_PATH = "section-10/scripts/run-reviewed-plan.mjs";
const SAFE_WORKFLOW_SHA256 = "337c1561ebebff73c35180216bdccae24e27d7ab530f269a3c55d05141a66bd2";
const SAFE_TEST_SHA256 = "45cb820aec176450d9f09fac29f34316e9cd85f3f006ce453c58a8b0f0df8a3a";
const SAFE_MAIN_SHA256 = "1be8f6407f2726f5b346ed9a761ce69700fb1884f2fdb48d52789f694148fd46";
const EXPECTED_RESOURCE_ACTIONS = new Map([
  ["terraform_data.reviewed_delivery", ["create"]],
]);
const KNOWN_ACTION_TOKENS = new Set(["no-op", "create", "read", "update", "delete", "forget"]);
const GIT = "/usr/bin/git";
const ENGINE = {
  terraform: {
    binaryName: "terraform",
    version: "1.14.8",
    candidates: ["/opt/homebrew/bin/terraform", "/usr/local/bin/terraform", "/usr/bin/terraform"],
  },
  opentofu: {
    binaryName: "tofu",
    version: "1.12.6",
    candidates: ["/opt/homebrew/bin/tofu", "/usr/local/bin/tofu", "/usr/bin/tofu"],
  },
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

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (index === process.argv.length - 1) reject("USAGE", `missing value for ${name}`);
  return process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function gitEnvironment() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: realpathSync(tmpdir()),
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

function command(executable, args, cwd, env, acceptedStatuses = [0]) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (!acceptedStatuses.includes(result.status)) {
    const detail = result.error?.message ?? result.stderr ?? result.stdout;
    reject("COMMAND_FAILED", `${basename(executable)} ${args[0]} failed:\n${detail}`);
  }
  return result;
}

function git(source, args, acceptedStatuses = [0]) {
  return command(GIT, args, source, gitEnvironment(), acceptedStatuses);
}

function gitText(source, args) {
  return git(source, args).stdout;
}

function gitHead(source) {
  return gitText(source, ["rev-parse", "HEAD"]).trim();
}

function gitBlob(source, revision, path) {
  return gitText(source, ["show", `${revision}:${path}`]);
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    reject("MANIFEST_INVALID", error.message);
  }
}

function assertReviewedSourceClean(source) {
  const status = gitText(source, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--",
    TERRAFORM_RELATIVE_PATH, WORKFLOW_RELATIVE_PATH, CHECKER_RELATIVE_PATH, RUNNER_RELATIVE_PATH,
  ]).trim();
  if (status) reject("DIRTY_OR_IGNORED_SOURCE", status);
}

function validateChangedPath(source, changed) {
  if (typeof changed !== "string" || isAbsolute(changed)) reject("SOURCE_ESCAPE", String(changed));
  const resolved = resolve(source, changed);
  if (!resolved.startsWith(`${source}${sep}`)) reject("SOURCE_ESCAPE", changed);
  const normalized = changed.replaceAll("\\", "/");
  if (normalized === WORKFLOW_RELATIVE_PATH || normalized === CHECKER_RELATIVE_PATH || normalized === RUNNER_RELATIVE_PATH || /(^|\/)\.github\/workflows\//.test(normalized) || /(^|\/)workflows\/[^/]+\.ya?ml$/.test(normalized)) {
    reject("WORKFLOW_IMMUTABLE", changed);
  }
  if (!/^section-10\/terraform\/[^/]+(?:\.tf|\.tftest\.hcl)$/.test(normalized)) {
    reject("CHANGE_SCOPE_FORBIDDEN", changed);
  }
  return normalized;
}

function actualChangedFiles(source, baseRevision, sourceRevision) {
  const ancestry = git(source, ["merge-base", "--is-ancestor", baseRevision, sourceRevision], [0, 1]);
  if (ancestry.status !== 0) reject("BASE_NOT_ANCESTOR", "base_revision must be an ancestor of source_revision");
  return gitText(source, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", `${baseRevision}..${sourceRevision}`, "--"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function validateChange(manifest, source, workflowBytes) {
  if (manifest.task_id !== TASK_ID) reject("TASK_ID_MISMATCH", "unexpected task_id");
  if (!/^[0-9a-f]{40}$/.test(manifest.source_revision ?? "") || manifest.source_revision !== gitHead(source)) {
    reject("STALE_SOURCE_REVISION", "manifest is not bound to current Git HEAD");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.base_revision ?? "")) {
    reject("BASE_REVISION_INVALID", "base_revision must be a full Git commit SHA");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.workflow_sha256 ?? "") || manifest.workflow_sha256 !== sha256(workflowBytes)) {
    reject("WORKFLOW_HASH_MISMATCH", "safe workflow bytes changed after review");
  }
  if (typeof manifest.proposer !== "string" || typeof manifest.approver !== "string" || !manifest.proposer || !manifest.approver) {
    reject("APPROVAL_IDENTITY", "proposer and approver are required");
  }
  if (manifest.proposer === manifest.approver) reject("SELF_APPROVAL", "the proposer cannot approve its own change");
  if (!Array.isArray(manifest.changed_files) || manifest.changed_files.length === 0) {
    reject("CHANGED_FILES_REQUIRED", "candidate manifest has no changed files");
  }
  const claimed = [...new Set(manifest.changed_files.map((changed) => validateChangedPath(source, changed)))].sort();
  if (claimed.length !== manifest.changed_files.length) reject("CHANGED_FILES_MISMATCH", "duplicate changed-file claims");
  const actual = actualChangedFiles(source, manifest.base_revision, manifest.source_revision);
  if (JSON.stringify(claimed) !== JSON.stringify(actual)) {
    reject("CHANGED_FILES_MISMATCH", `claimed ${JSON.stringify(claimed)}, actual ${JSON.stringify(actual)}`);
  }
}

function assertEvaluatorInvariant(source, revision) {
  const currentRunner = readFileSync(fileURLToPath(import.meta.url));
  const currentCheckerPath = join(dirname(fileURLToPath(import.meta.url)), "check-delivery-change.mjs");
  const currentChecker = readFileSync(currentCheckerPath);
  const committedRunner = Buffer.from(gitBlob(source, revision, RUNNER_RELATIVE_PATH));
  const committedChecker = Buffer.from(gitBlob(source, revision, CHECKER_RELATIVE_PATH));
  if (!currentRunner.equals(committedRunner) || !currentChecker.equals(committedChecker)) {
    reject("EVALUATOR_MISMATCH", "trusted launcher/checker bytes differ from source_revision");
  }
  return { runner: committedRunner, checker: committedChecker };
}

function immutableTerraformFiles(source, revision) {
  const listing = gitText(source, ["ls-tree", "-rz", revision, "--", TERRAFORM_RELATIVE_PATH]);
  const files = [];
  for (const record of listing.split("\0").filter(Boolean)) {
    const [metadata, path] = record.split("\t");
    const [mode, type] = metadata.split(" ");
    const name = relative(TERRAFORM_RELATIVE_PATH, path);
    if (mode !== "100644" || type !== "blob" || name.includes(sep) || !(name.endsWith(".tf") || name.endsWith(".tftest.hcl"))) {
      reject("UNEXPECTED_TERRAFORM_SOURCE", path);
    }
    files.push({ name, bytes: Buffer.from(gitBlob(source, revision, path)) });
  }
  if (files.length === 0) reject("UNEXPECTED_TERRAFORM_SOURCE", "empty Terraform tree");
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function validateTerraformFiles(files) {
  const tests = files.filter(({ name }) => name.endsWith(".tftest.hcl"));
  if (tests.length !== 1 || tests[0].name !== "reviewed-plan.tftest.hcl" || sha256(tests[0].bytes) !== SAFE_TEST_SHA256) {
    reject("TEST_INVARIANT", "the only executable test must be the protected plan-only test");
  }
  for (const { name, bytes } of files.filter((file) => file.name.endsWith(".tf"))) {
    const source = bytes.toString("utf8");
    if (/\brequired_providers\b|\bprovider\s+"/.test(source)) reject("PROVIDER_FORBIDDEN", name);
    if (/\bbackend\s+"|\bcloud\s*\{/.test(source)) reject("BACKEND_FORBIDDEN", name);
    if (/https?:\/\//.test(source)) reject("NETWORK_SOURCE_FORBIDDEN", name);
    if (/\bmodule\s+"|\bdata\s+"|\bterraform_remote_state\b/.test(source)) reject("MODULE_FORBIDDEN", name);
    if (/\b(?:credential|access_key|secret_key|token)\s*=/.test(source)) reject("CREDENTIAL_FORBIDDEN", name);
    if (/\bprovisioner\s+"|\bconnection\s*\{|\blocal-exec\b|\bremote-exec\b/.test(source)) {
      reject("EXECUTION_CONSTRUCT_FORBIDDEN", name);
    }
    for (const match of source.matchAll(/\bresource\s+"([^"]+)"/g)) {
      if (match[1] !== "terraform_data") reject("RESOURCE_TYPE_FORBIDDEN", match[1]);
    }
  }
  const main = files.find(({ name }) => name === "main.tf");
  if (files.length !== 2 || !main || sha256(main.bytes) !== SAFE_MAIN_SHA256) {
    reject("TERRAFORM_INVARIANT", "source_revision must contain only the protected provider-free fixture bytes");
  }
}

function validatedResourceActions(planJson) {
  if (!Array.isArray(planJson?.resource_changes) || planJson.resource_changes.length === 0) {
    reject("PLAN_RESOURCE_CHANGES_MISSING", "direct plan JSON must contain resource_changes");
  }
  const seen = new Set();
  const resourceActions = [];
  for (const resourceChange of planJson.resource_changes) {
    const address = resourceChange?.address;
    if (seen.has(address)) reject("PLAN_RESOURCE_ADDRESS_DUPLICATE", String(address));
    seen.add(address);
    const expectedActions = EXPECTED_RESOURCE_ACTIONS.get(address);
    if (!expectedActions) reject("PLAN_RESOURCE_ADDRESS_UNEXPECTED", String(address));
    if (resourceChange.mode !== "managed" || resourceChange.type !== "terraform_data" || resourceChange.name !== "reviewed_delivery") {
      reject("PLAN_RESOURCE_IDENTITY_INCONSISTENT", address);
    }
    const actions = resourceChange.change?.actions;
    if (!Array.isArray(actions)) reject("PLAN_ACTIONS_INVALID", address);
    if (actions.length === 0) reject("PLAN_ACTIONS_EMPTY", address);
    for (const action of actions) {
      if (typeof action !== "string" || !KNOWN_ACTION_TOKENS.has(action)) {
        reject("PLAN_ACTION_TOKEN_UNKNOWN", String(action));
      }
    }
    if (JSON.stringify(actions) !== JSON.stringify(expectedActions)) {
      reject("PLAN_ACTIONS_FORBIDDEN", `${address}: ${JSON.stringify(actions)}`);
    }
    resourceActions.push({ address, actions: [...actions] });
  }
  if (seen.size !== EXPECTED_RESOURCE_ACTIONS.size) {
    reject("PLAN_RESOURCE_ADDRESS_MISSING", "direct plan JSON omitted an intended resource address");
  }
  return resourceActions.sort((left, right) => left.address.localeCompare(right.address));
}

function trustedEngine(profile, explicitPath, expectedSha256) {
  if (explicitPath || expectedSha256) {
    if (!explicitPath || !/^[0-9a-f]{64}$/.test(expectedSha256 ?? "") || !isAbsolute(explicitPath)) {
      reject("ENGINE_BINDING_INVALID", "explicit engine requires an absolute path and SHA-256");
    }
    const logicalTemporaryRoot = resolve(tmpdir());
    const canonicalTemporaryRoot = realpathSync(logicalTemporaryRoot);
    const absolute = resolve(explicitPath);
    if ((!absolute.startsWith(`${logicalTemporaryRoot}${sep}`) && !absolute.startsWith(`${canonicalTemporaryRoot}${sep}`)) || basename(absolute) !== profile.binaryName) {
      reject("ENGINE_PATH_UNTRUSTED", explicitPath);
    }
    const parent = dirname(absolute);
    if (lstatSync(parent).isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) reject("ENGINE_PATH_UNTRUSTED", explicitPath);
    const canonicalParent = realpathSync(parent);
    if (dirname(canonicalParent) !== canonicalTemporaryRoot || !basename(canonicalParent).startsWith("agentic-iac-s10-engine-")) {
      reject("ENGINE_PATH_UNTRUSTED", explicitPath);
    }
    const parentStat = statSync(canonicalParent);
    const fileStat = statSync(absolute);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : fileStat.uid;
    if (parentStat.uid !== currentUid || fileStat.uid !== currentUid || (parentStat.mode & 0o077) !== 0 || (fileStat.mode & 0o022) !== 0 || (fileStat.mode & 0o100) === 0 || !fileStat.isFile()) {
      reject("ENGINE_PATH_UNTRUSTED", explicitPath);
    }
    const bytes = readFileSync(absolute);
    if (sha256(bytes) !== expectedSha256) reject("ENGINE_HASH_MISMATCH", explicitPath);
    return { binaryName: profile.binaryName, bytes };
  }
  for (const candidate of profile.candidates) {
    if (!existsSync(candidate)) continue;
    const executable = realpathSync(candidate);
    if (lstatSync(executable).isFile()) return { executable };
  }
  reject("ENGINE_NOT_TRUSTED", `none of the fixed engine paths exist: ${profile.candidates.join(", ")}`);
}

function materializeEngine(output, binding) {
  if (binding.executable) return binding.executable;
  const directory = join(output, "engine");
  const executable = join(directory, binding.binaryName);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(executable, binding.bytes, { mode: 0o500 });
  return executable;
}

function createOutput(requested, source) {
  const logicalTemporaryRoot = resolve(tmpdir());
  const canonicalTemporaryRoot = realpathSync(logicalTemporaryRoot);
  const absolute = resolve(requested);
  if (absolute === logicalTemporaryRoot || (!absolute.startsWith(`${logicalTemporaryRoot}${sep}`) && !absolute.startsWith(`${canonicalTemporaryRoot}${sep}`))) {
    reject("OUTPUT_OUTSIDE_TEMP", absolute);
  }
  if (!basename(absolute).startsWith("agentic-iac-s10-")) reject("OUTPUT_PREFIX", basename(absolute));
  const parent = dirname(absolute);
  if (lstatSync(parent).isSymbolicLink()) reject("OUTPUT_SYMLINK", parent);
  const canonicalParent = realpathSync(parent);
  if (canonicalParent.startsWith(`${source}${sep}`) || canonicalParent === source) reject("OUTPUT_IN_SOURCE", parent);
  if (canonicalParent !== canonicalTemporaryRoot) reject("OUTPUT_PARENT_FORBIDDEN", parent);
  const output = join(canonicalTemporaryRoot, basename(absolute));
  try {
    mkdirSync(output, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") reject("OUTPUT_EXISTS", output);
    reject("OUTPUT_CREATE_FAILED", error.message);
  }
  return output;
}

function executionEnvironment(output) {
  const home = join(output, "home");
  const data = join(output, "tf-data");
  const temporary = join(output, "tmp");
  for (const directory of [home, data, temporary]) mkdirSync(directory, { mode: 0o700 });
  return {
    CHECKPOINT_DISABLE: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TF_DATA_DIR: data,
    TF_IN_AUTOMATION: "true",
    TMPDIR: temporary,
  };
}

function materialize(output, terraformFiles, workflowBytes, checkerBytes) {
  const workingDirectory = join(output, "work", "terraform");
  const workflowPath = join(output, "work", "workflow", "terraform-plan.yml");
  const checkerPath = join(output, "work", "scripts", "check-delivery-change.mjs");
  mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(workflowPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(checkerPath), { recursive: true, mode: 0o700 });
  for (const { name, bytes } of terraformFiles) writeFileSync(join(workingDirectory, name), bytes, { mode: 0o600 });
  writeFileSync(workflowPath, workflowBytes, { mode: 0o600 });
  writeFileSync(checkerPath, checkerBytes, { mode: 0o600 });
  return { workingDirectory, workflowPath, checkerPath };
}

function main() {
  let output;
  try {
    const engineName = argument("--engine");
    const profile = ENGINE[engineName];
    if (!profile) reject("UNKNOWN_ENGINE", "accepted values are exactly terraform and opentofu");
    const engineBinding = trustedEngine(profile, optionalArgument("--engine-path"), optionalArgument("--engine-sha256"));
    const sourceInput = argument("--source");
    if (lstatSync(sourceInput).isSymbolicLink()) reject("SYMLINK_FORBIDDEN", sourceInput);
    const source = realpathSync(sourceInput);
    const manifestPath = argument("--manifest");
    if (lstatSync(manifestPath).isSymbolicLink()) reject("SYMLINK_FORBIDDEN", manifestPath);
    const manifest = readManifest(manifestPath);
    assertReviewedSourceClean(source);
    if (!/^[0-9a-f]{40}$/.test(manifest.source_revision ?? "") || manifest.source_revision !== gitHead(source)) {
      reject("STALE_SOURCE_REVISION", "manifest is not bound to current Git HEAD");
    }

    const workflowBytes = Buffer.from(gitBlob(source, manifest.source_revision, WORKFLOW_RELATIVE_PATH));
    if (sha256(workflowBytes) !== SAFE_WORKFLOW_SHA256) reject("WORKFLOW_INVARIANT", "source_revision does not contain the protected workflow");
    validateChange(manifest, source, workflowBytes);
    const evaluator = assertEvaluatorInvariant(source, manifest.source_revision);
    const terraformFiles = immutableTerraformFiles(source, manifest.source_revision);
    validateTerraformFiles(terraformFiles);

    output = createOutput(argument("--output"), source);
    writeFileSync(join(output, ".agentic-iac-s10-evidence-root"), `${TASK_ID}\n`, { mode: 0o600 });
    const env = executionEnvironment(output);
    const executable = materializeEngine(output, engineBinding);
    const materialized = materialize(output, terraformFiles, workflowBytes, evaluator.checker);
    command(process.execPath, [materialized.checkerPath, "--workflow", materialized.workflowPath], output, env);
    const versionJson = command(executable, ["version", "-json"], materialized.workingDirectory, env).stdout;
    const version = JSON.parse(versionJson).terraform_version;
    if (version !== profile.version) reject("ENGINE_VERSION_MISMATCH", `expected ${profile.version}, got ${version}`);

    command(executable, ["fmt", "-check", "-recursive"], materialized.workingDirectory, env);
    command(executable, ["init", "-backend=false", "-input=false", "-no-color"], materialized.workingDirectory, env);
    command(executable, ["validate", "-no-color"], materialized.workingDirectory, env);
    command(executable, ["test", "-no-color"], materialized.workingDirectory, env);
    const planPath = join(output, "reviewed.tfplan");
    command(executable, ["plan", "-input=false", "-lock=false", "-no-color", `-out=${planPath}`], materialized.workingDirectory, env);
    const planJsonPath = join(output, "reviewed-plan.json");
    const planJsonBytes = command(executable, ["show", "-json", planPath], materialized.workingDirectory, env).stdout;
    writeFileSync(planJsonPath, planJsonBytes, { mode: 0o600 });
    const planJson = JSON.parse(planJsonBytes);
    const resourceActions = validatedResourceActions(planJson);
    const resourceAddresses = resourceActions.map(({ address }) => address);

    const report = {
      task_id: TASK_ID,
      source_revision: manifest.source_revision,
      engine: engineName,
      engine_version: version,
      workflow_sha256: sha256(workflowBytes),
      plan_sha256: hashFile(planPath),
      plan_json_sha256: hashFile(planJsonPath),
      resource_addresses: resourceAddresses,
      resource_actions: resourceActions,
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
    const reportPath = join(output, "plan-evidence.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`READY_FOR_HUMAN_REVIEW ${reportPath}\n`);
  } catch (error) {
    if (output && existsSync(output)) rmSync(output, { recursive: true, force: true });
    const code = error instanceof GuardError ? error.code : "RUNNER_ERROR";
    process.stderr.write(`REJECTED ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();

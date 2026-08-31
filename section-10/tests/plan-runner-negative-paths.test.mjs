import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const runner = join(sectionRoot, "scripts", "run-reviewed-plan.mjs");
const sourceTerraform = join(sectionRoot, "terraform");
const sourceWorkflow = join(sectionRoot, "workflows", "terraform-plan.yml");
const sourceScripts = join(sectionRoot, "scripts");
const taskId = "section-10-task-2";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeSource() {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-source-test-"));
  mkdirSync(join(root, "section-10", "scripts"), { recursive: true });
  mkdirSync(join(root, "section-10", "workflows"), { recursive: true });
  cpSync(sourceTerraform, join(root, "section-10", "terraform"), { recursive: true });
  cpSync(sourceWorkflow, join(root, "section-10", "workflows", "terraform-plan.yml"));
  cpSync(join(sourceScripts, "check-delivery-change.mjs"), join(root, "section-10", "scripts", "check-delivery-change.mjs"));
  cpSync(join(sourceScripts, "run-reviewed-plan.mjs"), join(root, "section-10", "scripts", "run-reviewed-plan.mjs"));
  const candidateMain = readFileSync(join(root, "section-10", "terraform", "main.tf"), "utf8");
  writeFileSync(join(root, "section-10", "terraform", "main.tf"), candidateMain.replace('default     = "s10-v2"', 'default     = "s10-v1"'));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Section 10 Test"]);
  git(root, ["config", "user.email", "section10@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "reviewed base"]);
  writeFileSync(join(root, "section-10", "terraform", "main.tf"), candidateMain);
  git(root, ["add", "section-10/terraform/main.tf"]);
  git(root, ["commit", "-qm", "candidate delivery revision"]);
  return root;
}

function commitTerraformMutation(source, name, contents) {
  writeFileSync(join(source, "section-10", "terraform", name), contents);
  git(source, ["add", "section-10/terraform"]);
  git(source, ["commit", "-qm", `mutation ${name}`]);
}

function newOutput(label = "run") {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-name-"));
  rmSync(root, { recursive: true });
  return `${root}-${label}`;
}

function manifestFor(source, overrides = {}) {
  return {
    task_id: taskId,
    base_revision: git(source, ["rev-parse", "HEAD^"]),
    source_revision: git(source, ["rev-parse", "HEAD"]),
    workflow_sha256: sha256(join(source, "section-10", "workflows", "terraform-plan.yml")),
    proposer: "authoring-agent",
    approver: "human-reviewer",
    changed_files: ["section-10/terraform/main.tf"],
    ...overrides,
  };
}

function run(source, {
  engine = "terraform",
  enginePath,
  engineSha256,
  manifest = manifestFor(source),
  output = newOutput(),
  manifestPath,
  env = {},
} = {}) {
  const createdManifestRoot = manifestPath ? undefined : mkdtempSync(join(tmpdir(), "agentic-iac-s10-manifest-test-"));
  const external = manifestPath ?? join(createdManifestRoot, "change.json");
  if (!manifestPath) writeFileSync(external, `${JSON.stringify(manifest, null, 2)}\n`);
  const args = [
    runner,
    "--engine", engine,
    "--source", source,
    "--manifest", external,
    "--output", output,
  ];
  if (enginePath) args.push("--engine-path", enginePath);
  if (engineSha256) args.push("--engine-sha256", engineSha256);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", shell: false, env: { ...process.env, ...env } });
  if (createdManifestRoot) rmSync(createdManifestRoot, { recursive: true, force: true });
  return { ...result, output, manifestPath: external };
}

function setupActionEngine() {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-engine-"));
  const executable = join(root, "terraform");
  const marker = join(root, "invoked.log");
  const installed = realpathSync("/opt/homebrew/bin/terraform");
  writeFileSync(executable, `#!/bin/sh\nprintf invoked >> "${marker}"\nexec "${installed}" "$@"\n`);
  chmodSync(executable, 0o500);
  return { root, executable, marker, sha256: sha256(executable) };
}

function setupPlanJsonEngine(planJson) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-engine-"));
  const executable = join(root, "terraform");
  const installed = realpathSync("/opt/homebrew/bin/terraform");
  const serialized = JSON.stringify(planJson);
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "show" ] && [ "$2" = "-json" ]; then
  printf '%s\\n' '${serialized}'
  exit 0
fi
exec "${installed}" "$@"
`);
  chmodSync(executable, 0o500);
  return { root, executable, sha256: sha256(executable) };
}

function reviewedResourceChange(overrides = {}) {
  return {
    address: "terraform_data.reviewed_delivery",
    mode: "managed",
    type: "terraform_data",
    name: "reviewed_delivery",
    change: { actions: ["create"] },
    ...overrides,
  };
}

function expectRejected(result, code) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(code));
  assert.equal(existsSync(result.output), false, "rejection must not leave an evidence directory");
}

test("rejects an engine outside the exact enum", () => {
  const source = makeSource();
  const result = run(source, { engine: "Terraform" });
  expectRejected(result, "UNKNOWN_ENGINE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a changed safe-workflow hash", () => {
  const source = makeSource();
  const result = run(source, { manifest: manifestFor(source, { workflow_sha256: "0".repeat(64) }) });
  expectRejected(result, "WORKFLOW_HASH_MISMATCH");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a stale source revision", () => {
  const source = makeSource();
  const result = run(source, { manifest: manifestFor(source, { source_revision: "1".repeat(40) }) });
  expectRejected(result, "STALE_SOURCE_REVISION");
  rmSync(source, { recursive: true, force: true });
});

test("rejects uncommitted source that cannot be identified by HEAD", () => {
  const source = makeSource();
  const manifest = manifestFor(source);
  writeFileSync(join(source, "section-10", "terraform", "unreviewed.tf"), "locals { unreviewed = true }\n");
  const result = run(source, { manifest });
  expectRejected(result, "DIRTY_OR_IGNORED_SOURCE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects an ignored Terraform file even though immutable execution would not use it", () => {
  const source = makeSource();
  mkdirSync(join(source, "section-10", "terraform", ".terraform"));
  writeFileSync(join(source, "section-10", "terraform", ".terraform", "ignored"), "caller-controlled\n");
  const result = run(source);
  expectRejected(result, "DIRTY_OR_IGNORED_SOURCE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a committed evaluator that differs from the trusted launcher bytes", () => {
  const source = makeSource();
  const evaluator = join(source, "section-10", "scripts", "run-reviewed-plan.mjs");
  writeFileSync(evaluator, `${readFileSync(evaluator, "utf8")}\n// attacker edit\n`);
  git(source, ["add", "section-10/scripts/run-reviewed-plan.mjs"]);
  git(source, ["commit", "-qm", "malicious protected base"]);
  commitTerraformMutation(source, "placeholder.tf", "locals { placeholder = true }\n");
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["section-10/terraform/placeholder.tf"] }) });
  expectRejected(result, "EVALUATOR_MISMATCH");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a manifest whose changed files do not equal the Git diff", () => {
  const source = makeSource();
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["section-10/terraform/not-changed.tf"] }) });
  expectRejected(result, "CHANGED_FILES_MISMATCH");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a real Git diff outside the reviewed Terraform scope", () => {
  const source = makeSource();
  writeFileSync(join(source, "README.md"), "unrelated candidate change\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "unrelated candidate"]);
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["README.md"] }) });
  expectRejected(result, "CHANGE_SCOPE_FORBIDDEN");
  rmSync(source, { recursive: true, force: true });
});

test("rejects an apply-mode Terraform test", () => {
  const source = makeSource();
  const testFile = join(source, "section-10", "terraform", "reviewed-plan.tftest.hcl");
  writeFileSync(testFile, readFileSync(testFile, "utf8").replace("command = plan", "command = apply"));
  git(source, ["add", "section-10/terraform/reviewed-plan.tftest.hcl"]);
  git(source, ["commit", "-qm", "unsafe apply test"]);
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["section-10/terraform/reviewed-plan.tftest.hcl"] }) });
  expectRejected(result, "TEST_INVARIANT");
  rmSync(source, { recursive: true, force: true });
});

test("rejects arbitrary module execution added to an otherwise plan-mode Terraform test", () => {
  const source = makeSource();
  const testFile = join(source, "section-10", "terraform", "reviewed-plan.tftest.hcl");
  writeFileSync(testFile, `${readFileSync(testFile, "utf8")}\nrun "arbitrary_module" {\n  command = plan\n  module { source = "../outside" }\n}\n`);
  git(source, ["add", "section-10/terraform/reviewed-plan.tftest.hcl"]);
  git(source, ["commit", "-qm", "unsafe arbitrary test module"]);
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["section-10/terraform/reviewed-plan.tftest.hcl"] }) });
  expectRejected(result, "TEST_INVARIANT");
  rmSync(source, { recursive: true, force: true });
});

for (const provisioner of ["local-exec", "remote-exec"]) {
  test(`rejects a ${provisioner} provisioner before any Terraform command`, () => {
    const source = makeSource();
    const main = join(source, "section-10", "terraform", "main.tf");
    writeFileSync(main, readFileSync(main, "utf8").replace(
      "  input = {",
      `  provisioner "${provisioner}" {\n    command = "false"\n  }\n\n  input = {`,
    ));
    git(source, ["add", "section-10/terraform/main.tf"]);
    git(source, ["commit", "-qm", `unsafe ${provisioner}`]);
    const result = run(source, { manifest: manifestFor(source) });
    expectRejected(result, "EXECUTION_CONSTRUCT_FORBIDDEN");
    rmSync(source, { recursive: true, force: true });
  });
}

test("rejects arbitrary plan-time file evaluation in Terraform source", () => {
  const source = makeSource();
  const main = join(source, "section-10", "terraform", "main.tf");
  writeFileSync(main, `${readFileSync(main, "utf8")}\nlocals { caller_file = file("/etc/hosts") }\n`);
  git(source, ["add", "section-10/terraform/main.tf"]);
  git(source, ["commit", "-qm", "unsafe plan-time file read"]);
  const result = run(source);
  expectRejected(result, "TERRAFORM_INVARIANT");
  rmSync(source, { recursive: true, force: true });
});

test("ignores caller Terraform variables, CLI arguments, credentials, tokens, and proxies", () => {
  const source = makeSource();
  const callerData = join(source, "caller-tf-data");
  const result = run(source, { env: {
    HOME: source,
    PATH: "/attacker-controlled-bin",
    TF_CLI_ARGS: "-destroy",
    TF_CLI_CONFIG_FILE: join(source, "attacker.tfrc"),
    TF_DATA_DIR: callerData,
    TF_VAR_delivery_revision: "s10-v1",
    AWS_ACCESS_KEY_ID: "attacker",
    GITHUB_TOKEN: "attacker",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "*",
  } });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(join(result.output, "reviewed-plan.json"), "utf8"));
  assert.equal(plan.variables.delivery_revision.value, "s10-v2");
  assert.equal(existsSync(callerData), false);
  rmSync(result.output, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("a post-validation worktree mutation cannot change the immutable plan input", { timeout: 120_000 }, async () => {
  const source = makeSource();
  const manifestRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-toctou-manifest-"));
  const manifestPath = join(manifestRoot, "change.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifestFor(source), null, 2)}\n`);
  const output = newOutput("toctou");
  const child = spawn(process.execPath, [
    runner,
    "--engine", "terraform",
    "--source", source,
    "--manifest", manifestPath,
    "--output", output,
  ], { encoding: "utf8", shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const marker = join(output, ".agentic-iac-s10-evidence-root");
  const deadline = Date.now() + 5_000;
  while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
  assert.equal(existsSync(marker), true, `runner did not reach materialization boundary: ${stderr}`);
  assert.equal(child.exitCode, null, "mutation must occur while evaluator is still running");
  const main = join(source, "section-10", "terraform", "main.tf");
  writeFileSync(main, readFileSync(main, "utf8").replace('default     = "s10-v2"', 'default     = "s10-v1"'));

  const status = await new Promise((resolveExit) => child.once("close", resolveExit));
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  const plan = JSON.parse(readFileSync(join(output, "reviewed-plan.json"), "utf8"));
  assert.equal(plan.variables.delivery_revision.value, "s10-v2");
  rmSync(output, { recursive: true, force: true });
  rmSync(manifestRoot, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("the workflow launches the approved-base runner and candidate runner bytes never execute", () => {
  const workflow = readFileSync(sourceWorkflow, "utf8");
  const commandMatch = workflow.match(/node\s+([^\s]+run-reviewed-plan\.mjs)/);
  assert.ok(commandMatch, "workflow must contain a runner command");
  assert.equal(commandMatch[1], "trusted/section-10/scripts/run-reviewed-plan.mjs");

  const source = makeSource();
  const bootstrap = mkdtempSync(join(tmpdir(), "agentic-iac-s10-workflow-bootstrap-"));
  const candidateMarker = join(bootstrap, "candidate-runner-executed");
  const candidateRunner = join(source, "section-10", "scripts", "run-reviewed-plan.mjs");
  writeFileSync(candidateRunner, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(candidateMarker)}, "executed\\n");\n`);
  git(source, ["add", "section-10/scripts/run-reviewed-plan.mjs"]);
  git(source, ["commit", "-qm", "malicious candidate runner"]);
  const baseRevision = git(source, ["rev-list", "--max-parents=0", "HEAD"]);
  const sourceRevision = git(source, ["rev-parse", "HEAD"]);
  git(bootstrap, ["clone", "-q", source, "candidate"]);
  git(bootstrap, ["clone", "-q", source, "trusted"]);
  git(join(bootstrap, "trusted"), ["checkout", "-q", baseRevision]);
  const manifestPath = join(bootstrap, "reviewed-change.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    task_id: taskId,
    base_revision: baseRevision,
    source_revision: sourceRevision,
    workflow_sha256: sha256(join(bootstrap, "candidate", "section-10", "workflows", "terraform-plan.yml")),
    proposer: "authoring-agent",
    approver: "human-reviewer",
    changed_files: ["section-10/scripts/run-reviewed-plan.mjs", "section-10/terraform/main.tf"],
  }, null, 2)}\n`);
  const output = newOutput("workflow-bootstrap");
  const result = spawnSync(process.execPath, [
    join(bootstrap, commandMatch[1]),
    "--engine", "terraform",
    "--source", join(bootstrap, "candidate"),
    "--manifest", manifestPath,
    "--output", output,
  ], { cwd: bootstrap, encoding: "utf8", shell: false });
  const candidateExecuted = existsSync(candidateMarker);
  if (existsSync(output)) rmSync(output, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  rmSync(bootstrap, { recursive: true, force: true });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /WORKFLOW_IMMUTABLE|EVALUATOR_MISMATCH/);
  assert.equal(candidateExecuted, false);
});

test("accepts a hash-bound setup-action engine from an evaluator-owned temporary path", () => {
  const source = makeSource();
  const engine = setupActionEngine();
  const result = run(source, { enginePath: engine.executable, engineSha256: engine.sha256 });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(engine.marker), true, "the explicitly bound engine must execute");
  } finally {
    if (existsSync(result.output)) rmSync(result.output, { recursive: true, force: true });
    rmSync(engine.root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("rejects a setup-action engine whose bytes changed after hashing", () => {
  const source = makeSource();
  const engine = setupActionEngine();
  chmodSync(engine.executable, 0o700);
  appendFileSync(engine.executable, "# tampered\n");
  chmodSync(engine.executable, 0o500);
  const result = run(source, { enginePath: engine.executable, engineSha256: engine.sha256 });
  if (existsSync(result.output)) rmSync(result.output, { recursive: true, force: true });
  rmSync(engine.root, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /ENGINE_HASH_MISMATCH/);
});

const rejectedPlanActionEvidence = [
  [
    "missing resource_changes instead of treating the plan gate as an unconditional PASS",
    {},
    "PLAN_RESOURCE_CHANGES_MISSING",
  ],
  [
    "a duplicate reviewed resource address",
    { resource_changes: [reviewedResourceChange(), reviewedResourceChange()] },
    "PLAN_RESOURCE_ADDRESS_DUPLICATE",
  ],
  [
    "an unexpected resource address",
    { resource_changes: [reviewedResourceChange({ address: "terraform_data.unreviewed_delivery", name: "unreviewed_delivery" })] },
    "PLAN_RESOURCE_ADDRESS_UNEXPECTED",
  ],
  [
    "an empty action array",
    { resource_changes: [reviewedResourceChange({ change: { actions: [] } })] },
    "PLAN_ACTIONS_EMPTY",
  ],
  [
    "an unknown action token",
    { resource_changes: [reviewedResourceChange({ change: { actions: ["execute"] } })] },
    "PLAN_ACTION_TOKEN_UNKNOWN",
  ],
  [
    "an address whose resource identity fields disagree",
    { resource_changes: [reviewedResourceChange({ type: "null_resource" })] },
    "PLAN_RESOURCE_IDENTITY_INCONSISTENT",
  ],
  [
    "a known action outside the reviewed plan-only create contract",
    { resource_changes: [reviewedResourceChange({ change: { actions: ["update"] } })] },
    "PLAN_ACTIONS_FORBIDDEN",
  ],
  [
    "a replacement action array outside the reviewed plan-only create contract",
    { resource_changes: [reviewedResourceChange({ change: { actions: ["delete", "create"] } })] },
    "PLAN_ACTIONS_FORBIDDEN",
  ],
];

for (const [label, planJson, code] of rejectedPlanActionEvidence) {
  test(`rejects direct plan JSON with ${label}`, { timeout: 120_000 }, () => {
    const source = makeSource();
    const engine = setupPlanJsonEngine(planJson);
    const result = run(source, { enginePath: engine.executable, engineSha256: engine.sha256 });
    try {
      expectRejected(result, code);
    } finally {
      if (existsSync(result.output)) rmSync(result.output, { recursive: true, force: true });
      rmSync(engine.root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });
}

test("rejects a symlink substituted for the setup-action engine", () => {
  const source = makeSource();
  const engineRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-engine-"));
  const executable = join(engineRoot, "terraform");
  const installed = realpathSync("/opt/homebrew/bin/terraform");
  symlinkSync(installed, executable);
  const result = run(source, { enginePath: executable, engineSha256: sha256(installed) });
  if (existsSync(result.output)) rmSync(result.output, { recursive: true, force: true });
  rmSync(engineRoot, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /ENGINE_PATH_UNTRUSTED/);
});

test("rejects a caller-controlled output parent even when it is below OS temp", () => {
  const source = makeSource();
  const parent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-caller-parent-"));
  const output = join(parent, "agentic-iac-s10-evidence");
  const result = run(source, { output });
  expectRejected(result, "OUTPUT_PARENT_FORBIDDEN");
  rmSync(parent, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

const forbiddenTerraformSources = [
  ["a provider", "provider.tf", 'provider "aws" {}\n', "PROVIDER_FORBIDDEN"],
  ["a state backend", "backend.tf", 'terraform { backend "s3" {} }\n', "BACKEND_FORBIDDEN"],
  ["a remote module", "module.tf", 'module "remote" { source = "https://example.invalid/module" }\n', "NETWORK_SOURCE_FORBIDDEN"],
  ["a credential", "credential.tf", 'locals { access_key = "not-allowed" }\n', "CREDENTIAL_FORBIDDEN"],
  ["a non-terraform_data resource", "resource.tf", 'resource "null_resource" "unsafe" {}\n', "RESOURCE_TYPE_FORBIDDEN"],
];

for (const [label, name, contents, code] of forbiddenTerraformSources) {
  test(`rejects Terraform source containing ${label}`, () => {
    const source = makeSource();
    commitTerraformMutation(source, name, contents);
    const result = run(source, { manifest: manifestFor(source, { changed_files: [`section-10/terraform/${name}`] }) });
    expectRejected(result, code);
    rmSync(source, { recursive: true, force: true });
  });
}

test("rejects ignored Terraform working data instead of copying it into evidence", () => {
  const source = makeSource();
  mkdirSync(join(source, "section-10", "terraform", ".terraform"));
  writeFileSync(join(source, "section-10", "terraform", ".terraform", "injected"), "unreviewed\n");
  const result = run(source);
  expectRejected(result, "DIRTY_OR_IGNORED_SOURCE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a candidate that changes the guarded workflow", () => {
  const source = makeSource();
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["section-10/workflows/terraform-plan.yml"] }) });
  expectRejected(result, "WORKFLOW_IMMUTABLE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a candidate file path that escapes source", () => {
  const source = makeSource();
  const result = run(source, { manifest: manifestFor(source, { changed_files: ["../outside.tf"] }) });
  expectRejected(result, "SOURCE_ESCAPE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects a symlink in the reviewed Terraform source", () => {
  const source = makeSource();
  const main = join(source, "section-10", "terraform", "main.tf");
  const outside = join(dirname(source), `${source.split("/").at(-1)}-outside.tf`);
  writeFileSync(outside, readFileSync(main));
  rmSync(main);
  symlinkSync(outside, main);
  const result = run(source);
  expectRejected(result, "DIRTY_OR_IGNORED_SOURCE");
  rmSync(source, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

test("rejects a symlinked reviewed-change manifest", () => {
  const source = makeSource();
  const manifestRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-manifest-link-test-"));
  const target = join(manifestRoot, "target.json");
  const link = join(manifestRoot, "change.json");
  writeFileSync(target, `${JSON.stringify(manifestFor(source), null, 2)}\n`);
  symlinkSync(target, link);
  const result = run(source, { manifestPath: link });
  expectRejected(result, "SYMLINK_FORBIDDEN");
  rmSync(manifestRoot, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("rejects a pre-existing evidence output", () => {
  const source = makeSource();
  const output = newOutput("existing");
  mkdirSync(output);
  const result = run(source, { output });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /OUTPUT_EXISTS/);
  assert.equal(existsSync(output), true, "runner must not remove a directory it did not create");
  rmSync(output, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("rejects output inside the reviewed Git source", () => {
  const source = makeSource();
  const output = join(source, "agentic-iac-s10-evidence");
  const result = run(source, { output });
  expectRejected(result, "OUTPUT_IN_SOURCE");
  rmSync(source, { recursive: true, force: true });
});

test("rejects output outside the OS temporary directory", () => {
  const source = makeSource();
  const output = join(sectionRoot, "agentic-iac-s10-evidence");
  const result = run(source, { output });
  expectRejected(result, "OUTPUT_OUTSIDE_TEMP");
  rmSync(source, { recursive: true, force: true });
});

test("rejects an output path reached through a symlink", () => {
  const source = makeSource();
  const linkRoot = join(tmpdir(), `agentic-iac-s10-link-${process.pid}-${Date.now()}`);
  symlinkSync(source, linkRoot);
  const output = join(linkRoot, "agentic-iac-s10-evidence");
  const result = run(source, { output });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /OUTPUT_SYMLINK/);
  unlinkSync(linkRoot);
  rmSync(source, { recursive: true, force: true });
});

test("rejects self-approval", () => {
  const source = makeSource();
  const result = run(source, { manifest: manifestFor(source, { approver: "authoring-agent" }) });
  expectRejected(result, "SELF_APPROVAL");
  rmSync(source, { recursive: true, force: true });
});

for (const engine of ["terraform", "opentofu"]) {
  test(`${engine} produces plan evidence bound to source, workflow, hashes, addresses, and closed apply permission`, { timeout: 120_000 }, () => {
    const source = makeSource();
    const manifest = manifestFor(source);
    const result = run(source, { engine, manifest });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /READY_FOR_HUMAN_REVIEW/);
    const reportPath = join(result.output, "plan-evidence.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(Object.keys(report).sort(), [
      "apply_permitted", "engine", "engine_version", "gate_results", "plan_json_sha256",
      "plan_sha256", "resource_actions", "resource_addresses", "source_revision", "task_id", "workflow_sha256",
    ]);
    assert.equal(report.task_id, taskId);
    assert.equal(report.source_revision, manifest.source_revision);
    assert.equal(report.engine, engine);
    assert.match(report.engine_version, /^\d+\.\d+\.\d+$/);
    assert.equal(report.workflow_sha256, manifest.workflow_sha256);
    assert.match(report.plan_sha256, /^[0-9a-f]{64}$/);
    assert.match(report.plan_json_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(report.resource_addresses, ["terraform_data.reviewed_delivery"]);
    assert.deepEqual(report.resource_actions, [
      { address: "terraform_data.reviewed_delivery", actions: ["create"] },
    ]);
    assert.equal(report.apply_permitted, false);
    assert.deepEqual(report.gate_results, {
      format: "PASS",
      init_backend_disabled: "PASS",
      validate: "PASS",
      tests: "PASS",
      plan: "PASS",
      plan_json: "PASS",
      workflow_contract: "PASS",
      change_contract: "PASS",
    });
    assert.equal(readFileSync(join(result.output, ".agentic-iac-s10-evidence-root"), "utf8"), `${taskId}\n`);
    assert.equal(existsSync(join(source, "section-10", "terraform", "tfplan")), false);
    assert.equal(existsSync(join(source, "section-10", "terraform", "terraform.tfstate")), false);
    rmSync(result.output, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });
}

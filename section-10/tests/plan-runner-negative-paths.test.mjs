import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const runner = join(sectionRoot, "scripts", "run-reviewed-plan.mjs");
const sourceTerraform = join(sectionRoot, "terraform");
const sourceWorkflow = join(sectionRoot, "workflows", "terraform-plan.yml");
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
  mkdirSync(join(root, "section-10", "workflows"), { recursive: true });
  cpSync(sourceTerraform, join(root, "section-10", "terraform"), { recursive: true });
  cpSync(sourceWorkflow, join(root, "section-10", "workflows", "terraform-plan.yml"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Section 10 Test"]);
  git(root, ["config", "user.email", "section10@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
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
    source_revision: git(source, ["rev-parse", "HEAD"]),
    workflow_sha256: sha256(join(source, "section-10", "workflows", "terraform-plan.yml")),
    proposer: "authoring-agent",
    approver: "human-reviewer",
    changed_files: ["section-10/terraform/main.tf"],
    ...overrides,
  };
}

function run(source, { engine = "terraform", manifest = manifestFor(source), output = newOutput(), manifestPath } = {}) {
  const createdManifestRoot = manifestPath ? undefined : mkdtempSync(join(tmpdir(), "agentic-iac-s10-manifest-test-"));
  const external = manifestPath ?? join(createdManifestRoot, "change.json");
  if (!manifestPath) writeFileSync(external, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    runner,
    "--engine", engine,
    "--source", source,
    "--manifest", external,
    "--output", output,
  ], { encoding: "utf8", shell: false });
  if (createdManifestRoot) rmSync(createdManifestRoot, { recursive: true, force: true });
  return { ...result, output, manifestPath: external };
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
  expectRejected(result, "DIRTY_SOURCE");
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
    const result = run(source);
    expectRejected(result, code);
    rmSync(source, { recursive: true, force: true });
  });
}

test("rejects ignored Terraform working data instead of copying it into evidence", () => {
  const source = makeSource();
  mkdirSync(join(source, "section-10", "terraform", ".terraform"));
  writeFileSync(join(source, "section-10", "terraform", ".terraform", "injected"), "unreviewed\n");
  const result = run(source);
  expectRejected(result, "UNEXPECTED_TERRAFORM_SOURCE");
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
  expectRejected(result, "SYMLINK_FORBIDDEN");
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
      "plan_sha256", "resource_addresses", "source_revision", "task_id", "workflow_sha256",
    ]);
    assert.equal(report.task_id, taskId);
    assert.equal(report.source_revision, manifest.source_revision);
    assert.equal(report.engine, engine);
    assert.match(report.engine_version, /^\d+\.\d+\.\d+$/);
    assert.equal(report.workflow_sha256, manifest.workflow_sha256);
    assert.match(report.plan_sha256, /^[0-9a-f]{64}$/);
    assert.match(report.plan_json_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(report.resource_addresses, ["terraform_data.reviewed_delivery"]);
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

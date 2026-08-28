import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const repositoryRoot = join(sectionRoot, "..");
const runner = join(sectionRoot, "scripts", "run-starter-review.mjs");

function command(executable, args, options = {}) {
  return spawnSync(executable, args, { encoding: "utf8", shell: false, ...options });
}

function git(root, args) {
  const result = command("git", args, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root, message) {
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function makeRepository({ repaired = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-starter-source-"));
  cpSync(sectionRoot, join(root, "section-10"), { recursive: true });
  mkdirSync(join(root, "section-9", "policy"), { recursive: true });
  cpSync(join(repositoryRoot, "section-9", "policy", "workload.rego"), join(root, "section-9", "policy", "workload.rego"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Section 10 Test"]);
  git(root, ["config", "user.email", "section10@example.invalid"]);
  const trusted = commit(root, "approved evaluator base");
  if (repaired) {
    cpSync(join(root, "section-10", "recovery", "reviewed", "changed-files.txt"), join(root, "section-10", "starter", "changed-files.txt"));
    cpSync(join(root, "section-10", "recovery", "reviewed", "delivery-decision.json"), join(root, "section-10", "starter", "delivery-decision.json"));
    cpSync(join(root, "section-10", "recovery", "reviewed", "gitops", "application.yaml"), join(root, "section-10", "starter", "gitops", "application.yaml"));
    commit(root, "reviewed learner repair");
  }
  return { root, trusted, candidate: git(root, ["rev-parse", "HEAD"]) };
}

function mutate(source, relative, transform, message = "candidate mutation") {
  const path = join(source.root, relative);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, typeof transform === "function" ? transform(original) : transform);
  source.candidate = commit(source.root, message);
}

function add(source, relative, contents, message = "candidate addition") {
  const path = join(source.root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  source.candidate = commit(source.root, message);
}

function newOutput(label = "review") {
  const path = mkdtempSync(join(tmpdir(), `agentic-iac-s10-${label}-`));
  rmSync(path, { recursive: true });
  return path;
}

function review(source, extras = [], environment = process.env) {
  const output = newOutput();
  const result = command(process.execPath, [
    runner,
    "--source", source.root,
    "--trusted-revision", source.trusted,
    "--candidate-revision", source.candidate,
    "--output", output,
    ...extras,
  ], { env: environment });
  return { ...result, output };
}

function rejected(result, code) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(code));
  assert.equal(existsSync(result.output), false);
}

test("trusted-base launcher accepts the bounded reviewed repair", () => {
  const source = makeRepository();
  const result = review(source);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(result.output, "report.json"), "utf8"));
  assert.equal(report.status, "READY_FOR_HUMAN_REVIEW");
  assert.deepEqual(report.findings, []);
  assert.equal(report.trusted_revision, source.trusted);
  assert.equal(report.candidate_revision, source.candidate);
  assert.equal(report.apply_permitted, false);
  rmSync(result.output, { recursive: true });
  rmSync(source.root, { recursive: true });
});

test("trusted-base launcher reports exactly the three seeded starter findings", () => {
  const source = makeRepository({ repaired: false });
  const result = review(source);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(result.output, "report.json"), "utf8"));
  assert.equal(report.status, "REJECTED");
  assert.deepEqual(report.findings.map(({ id }) => id), [
    "S10_ARGO_AUTOMATION_ENABLED",
    "S10_AUTHOR_SELF_APPROVAL",
    "S10_PRIVILEGED_WORKFLOW_CHANGED",
  ]);
  rmSync(result.output, { recursive: true });
  rmSync(source.root, { recursive: true });
});

test("caller PATH tools cannot replace the fixed portable tool candidates", () => {
  const source = makeRepository();
  const attacker = mkdtempSync(join(tmpdir(), "agentic-iac-s10-path-tools-"));
  const marker = join(attacker, "invoked");
  for (const name of ["terraform", "tofu", "helm", "conftest", "git"]) {
    const path = join(attacker, name);
    writeFileSync(path, `#!/bin/sh\nprintf invoked >> ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(path, 0o500);
  }
  const result = review(source, [], { ...process.env, PATH: attacker, TF_CLI_ARGS: "-destroy", TF_VAR_image_tag: "attacker", GITHUB_TOKEN: "attacker" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(marker), false);
  rmSync(result.output, { recursive: true });
  rmSync(attacker, { recursive: true });
  rmSync(source.root, { recursive: true });
});

test("candidate launcher and contract replacements never execute", () => {
  const source = makeRepository();
  const marker = join(source.root, "candidate-launcher-ran");
  mutate(source, "section-10/scripts/run-starter-review.mjs", `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
  add(source, "section-10/contracts/starter-review.json", '{"weakened":true}\n', "replace evaluator contract");
  const result = review(source);
  rejected(result, "CANDIDATE_SCOPE_FORBIDDEN");
  assert.equal(existsSync(marker), false);
  rmSync(source.root, { recursive: true });
});

for (const [name, addition, code] of [
  ["provider", '\nprovider "external" {}\n', "PROVIDER_FORBIDDEN"],
  ["backend", '\nterraform { backend "local" {} }\n', "BACKEND_FORBIDDEN"],
  ["module", '\nmodule "remote" { source = "https://example.invalid/module" }\n', "MODULE_FORBIDDEN"],
  ["data", '\ndata "external" "run" { program = ["false"] }\n', "DATA_FORBIDDEN"],
  ["file", '\nlocals { host = file("/etc/hosts") }\n', "FUNCTION_FORBIDDEN"],
  ["provisioner", '\nresource "terraform_data" "bad" { provisioner "local-exec" { command = "false" } }\n', "EXECUTION_CONSTRUCT_FORBIDDEN"],
]) {
  test(`unsafe ${name} HCL rejects before the supplied engine can execute`, () => {
    const source = makeRepository();
    mutate(source, "section-10/starter/terraform/main.tf", (text) => `${text}${addition}`);
    const engineRoot = mkdtempSync(join(tmpdir(), "agentic-iac-s10-engine-"));
    const engine = join(engineRoot, "terraform");
    const marker = join(engineRoot, "invoked");
    writeFileSync(engine, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(engine, 0o500);
    const digest = createHash("sha256").update(readFileSync(engine)).digest("hex");
    const result = review(source, ["--engine", "terraform", "--engine-path", engine, "--engine-sha256", digest]);
    rejected(result, code);
    assert.equal(existsSync(marker), false);
    rmSync(engineRoot, { recursive: true });
    rmSync(source.root, { recursive: true });
  });
}

test("extra HCL rejects before engine execution", () => {
  const source = makeRepository();
  add(source, "section-10/starter/terraform/extra.tf", "locals { extra = true }\n");
  const result = review(source);
  rejected(result, "TERRAFORM_TREE_INVALID");
  rmSync(source.root, { recursive: true });
});

test("a symlinked Terraform directory in candidate Git rejects without reading its target", () => {
  const source = makeRepository();
  rmSync(join(source.root, "section-10", "starter", "terraform"), { recursive: true });
  symlinkSync("/etc", join(source.root, "section-10", "starter", "terraform"));
  source.candidate = commit(source.root, "replace Terraform tree with symlink");
  const result = review(source);
  rejected(result, "TERRAFORM_TREE_INVALID");
  rmSync(source.root, { recursive: true });
});

test("changing both author and reviewer identities cannot redefine approval", () => {
  const source = makeRepository();
  mutate(source, "section-10/starter/delivery-decision.json", (text) => text
    .replaceAll("agent-author", "candidate-author")
    .replaceAll("human-platform-reviewer", "candidate-reviewer"));
  const result = review(source);
  rejected(result, "DECISION_SCHEMA_INVALID");
  rmSync(source.root, { recursive: true });
});

for (const [name, transform] of [
  ["wrong Application name", (text) => text.replace("name: inference-platform", "name: other")],
  ["missing destination", (text) => text.replace(/  destination:[\s\S]*?  syncPolicy:/, "  syncPolicy:")],
  ["wrong repository", (text) => text.replace("git://agentic-iac-s10-git:9418/delivery.git", "https://example.invalid/repo")],
  ["moving target revision", (text) => text.replace("targetRevision: HEAD", "targetRevision: main")],
  ["malformed YAML", () => "apiVersion: [\n"],
]) {
  test(`${name} rejects as an invalid Application contract`, () => {
    const source = makeRepository();
    mutate(source, "section-10/starter/gitops/application.yaml", transform);
    const result = review(source);
    rejected(result, "APPLICATION_SCHEMA_INVALID");
    rmSync(source.root, { recursive: true });
  });
}

test("an extra declared changed path rejects", () => {
  const source = makeRepository();
  mutate(source, "section-10/starter/changed-files.txt", (text) => `${text}section-10/starter/README.md\n`);
  const result = review(source);
  rejected(result, "CHANGED_FILES_INVALID");
  rmSync(source.root, { recursive: true });
});

for (const [name, mutateChart] of [
  ["extra chart template", (source) => add(source, "section-10/starter/gitops/chart/templates/clusterrole.yaml", "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: bad\nrules: []\n")],
  ["extra .helmignore", (source) => add(source, "section-10/starter/gitops/chart/.helmignore", "templates/**\n")],
  ["Helm hook", (source) => mutate(source, "section-10/starter/gitops/chart/templates/configmap.yaml", (text) => text.replace("metadata:\n", 'metadata:\n  annotations:\n    "helm.sh/hook": pre-install\n'))],
  ["weakened probe", (source) => mutate(source, "section-10/starter/gitops/chart/templates/deployment.yaml", (text) => text.replace("readinessProbe:", "readinessProbeRemoved:"))],
  ["missing template", (source) => { rmSync(join(source.root, "section-10/starter/gitops/chart/templates/serviceaccount.yaml")); source.candidate = commit(source.root, "remove chart template"); }],
]) {
  test(`${name} rejects before Helm accepts candidate bytes`, () => {
    const source = makeRepository();
    mutateChart(source);
    const result = review(source);
    rejected(result, "CHART_INVARIANT");
    rmSync(source.root, { recursive: true });
  });
}

test("a symlinked source ancestor rejects", () => {
  const source = makeRepository();
  const parent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-source-link-"));
  const linked = join(parent, "repo");
  symlinkSync(source.root, linked);
  const result = review({ ...source, root: linked });
  rejected(result, "SYMLINK_ANCESTOR");
  rmSync(parent, { recursive: true, force: true });
  rmSync(source.root, { recursive: true });
});

test("a symlinked output ancestor rejects", () => {
  const source = makeRepository();
  const parent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-output-link-"));
  const real = mkdtempSync(join(tmpdir(), "agentic-iac-s10-output-real-"));
  const linked = join(parent, "linked");
  symlinkSync(real, linked);
  const output = join(linked, "agentic-iac-s10-review");
  const result = command(process.execPath, [runner, "--source", source.root, "--trusted-revision", source.trusted, "--candidate-revision", source.candidate, "--output", output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SYMLINK_ANCESTOR/);
  assert.equal(existsSync(output), false);
  rmSync(parent, { recursive: true, force: true });
  rmSync(real, { recursive: true, force: true });
  rmSync(source.root, { recursive: true });
});

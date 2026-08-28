import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
const starter = join(sectionRoot, "starter");
const launcher = join(starter, "protected", "check-candidate.mjs");
const protectedManifest = join(starter, "protected", "manifest.json");
const evidenceSchema = join(starter, "protected", "evidence.schema.json");
const cleanup = join(starter, "protected", "cleanup-evidence.mjs");
const policy = join(sectionRoot, "policy", "delivery.rego");
const application = join(starter, "gitops", "application.yaml");
const workflow = join(starter, "workflows", "terraform-plan.yml");
const decision = join(starter, "delivery-decision.json");
const changedFiles = join(starter, "changed-files.txt");
const chart = join(starter, "gitops", "chart");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: sectionRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });
}

function evaluate(candidate = starter) {
  const output = mkdtempSync(join(tmpdir(), "agentic-iac-s10-starter-test-"));
  rmSync(output, { recursive: true });
  const result = run(process.execPath, [launcher, candidate, output]);
  return { result, output };
}

test("the learner request, contract, and protected evaluator files exist", () => {
  for (const relative of [
    "README.md",
    "request.md",
    "task.md",
    "starter/changed-files.txt",
    "starter/delivery-decision.json",
    "starter/terraform/main.tf",
    "starter/workflows/terraform-plan.yml",
    "starter/gitops/application.yaml",
    "starter/protected/check-candidate.mjs",
    "starter/protected/cleanup-evidence.mjs",
    "starter/protected/evidence.schema.json",
    "starter/protected/manifest.json",
    "policy/delivery.rego",
  ]) {
    assert.ok(existsSync(join(sectionRoot, relative)), `missing ${relative}`);
  }
});

test("the manifest freezes only the bounded learner-editable files", () => {
  const manifest = JSON.parse(readFileSync(protectedManifest, "utf8"));
  assert.deepEqual(manifest.learner_editable, [
    "changed-files.txt",
    "delivery-decision.json",
    "gitops/application.yaml",
    "terraform/main.tf",
  ]);
  assert.deepEqual(manifest.primary_finding_ids, [
    "S10_ARGO_AUTOMATION_ENABLED",
    "S10_AUTHOR_SELF_APPROVAL",
    "S10_PRIVILEGED_WORKFLOW_CHANGED",
  ]);
  for (const protectedPath of [
    "protected/check-candidate.mjs",
    "protected/cleanup-evidence.mjs",
    "protected/evidence.schema.json",
    "workflows/terraform-plan.yml",
  ]) {
    assert.match(manifest.protected_sha256[protectedPath], /^[0-9a-f]{64}$/);
  }
});

test("the unsafe starter reports exactly the three approved primary findings", () => {
  const { result, output } = evaluate();
  try {
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    assert.equal(report.status, "REJECTED");
    assert.deepEqual(report.findings.map(({ id }) => id).sort(), [
      "S10_ARGO_AUTOMATION_ENABLED",
      "S10_AUTHOR_SELF_APPROVAL",
      "S10_PRIVILEGED_WORKFLOW_CHANGED",
    ]);
    assert.equal(report.findings.length, 3);
    assert.equal(report.apply_permitted, false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("the candidate workflow is inert at repository root and is privileged by event and permissions", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /^on:\n  pull_request_target:/m);
  assert.match(source, /permissions:\n  contents: write\n  id-token: write/);
  assert.ok(!existsSync(join(sectionRoot, ".github", "workflows")));
  assert.match(readFileSync(changedFiles, "utf8"), /workflows\/terraform-plan\.yml/);
});

test("the four identities are named and the author supplies its own approval", () => {
  const input = JSON.parse(readFileSync(decision, "utf8"));
  assert.deepEqual(Object.keys(input.identities).sort(), ["author", "delivery", "reviewer", "runtime"]);
  assert.equal(input.identities.author, input.approval.approved_by);
  assert.notEqual(input.identities.author, input.identities.reviewer);
  assert.notEqual(input.identities.delivery, input.identities.runtime);
});

test("the GitOps starter enables both unsafe automated controls", () => {
  const source = readFileSync(application, "utf8");
  assert.match(source, /automated:\n\s+prune: true\n\s+selfHeal: true/);
  assert.match(source, /targetRevision: HEAD/);
});

test("Terraform and OpenTofu validate the same provider-free intent", () => {
  for (const engine of ["terraform", "tofu"]) {
    const data = mkdtempSync(join(tmpdir(), `agentic-iac-s10-${engine}-data-`));
    const init = run(engine, ["-chdir=starter/terraform", "init", "-backend=false", "-input=false", "-no-color"], {
      env: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", PATH: process.env.PATH, TF_DATA_DIR: data },
    });
    assert.equal(init.status, 0, `${engine} init: ${init.stderr}${init.stdout}`);
    const validate = run(engine, ["-chdir=starter/terraform", "validate", "-no-color"], {
      env: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", PATH: process.env.PATH, TF_DATA_DIR: data },
    });
    rmSync(data, { recursive: true, force: true });
    assert.equal(validate.status, 0, `${engine} validate: ${validate.stderr}${validate.stdout}`);
  }
});

test("the repaired chart preserves structure, security, probes, resources, and an external Secret", () => {
  const lint = run("helm", ["lint", chart]);
  assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  const rendered = run("helm", ["template", "inference-platform", chart, "--namespace", "inference"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.doesNotMatch(rendered.stdout, /^kind: Secret$/m);
  assert.match(rendered.stdout, /name: inference-platform-backend-token/);
  assert.match(rendered.stdout, /readinessProbe:/);
  assert.match(rendered.stdout, /livenessProbe:/);
  assert.match(rendered.stdout, /runAsNonRoot: true/);
  assert.match(rendered.stdout, /allowPrivilegeEscalation: false/);
  assert.match(rendered.stdout, /requests:\n\s+cpu: 10m\n\s+memory: 32Mi/);
  assert.match(rendered.stdout, /limits:\n\s+cpu: 100m\n\s+memory: 64Mi/);
  assert.doesNotMatch(rendered.stdout, /^kind: NetworkPolicy$/m);

  const policy = run("conftest", ["test", "-", "--parser", "yaml", "--policy", join(sectionRoot, "..", "section-9", "policy"), "--output", "json"], {
    input: rendered.stdout,
  });
  assert.equal(policy.status, 0, policy.stderr || policy.stdout);
});

test("a learner cannot change protected evaluator bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-protected-test-"));
  const copy = run("cp", ["-R", starter, join(root, "starter")]);
  assert.equal(copy.status, 0, copy.stderr);
  writeFileSync(join(root, "starter", "workflows", "terraform-plan.yml"), "name: weakened\n");
  const output = join(root, "agentic-iac-s10-output");
  const result = run(process.execPath, [launcher, join(root, "starter"), output]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /PROTECTED_FILE_CHANGED/);
  rmSync(root, { recursive: true, force: true });
});

test("a recovery override cannot add a file outside the learner allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-scope-test-"));
  const overrides = join(root, "reviewed");
  mkdirSync(join(overrides, "protected"), { recursive: true });
  writeFileSync(join(overrides, "protected", "weaken-policy.txt"), "not allowed\n");
  const output = join(tmpdir(), `agentic-iac-s10-scope-output-${process.pid}`);
  const result = run(process.execPath, [launcher, starter, output, "--overrides", overrides]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /OVERRIDE_SCOPE_FORBIDDEN/);
  assert.equal(existsSync(output), false);
  rmSync(root, { recursive: true, force: true });
});

test("a recovery override cannot substitute a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-override-link-test-"));
  const overrides = join(root, "reviewed");
  mkdirSync(overrides, { recursive: true });
  symlinkSync(join(sectionRoot, "recovery", "reviewed", "delivery-decision.json"), join(overrides, "delivery-decision.json"));
  const output = join(tmpdir(), `agentic-iac-s10-link-output-${process.pid}`);
  const result = run(process.execPath, [launcher, starter, output, "--overrides", overrides]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /UNSAFE_FILE_TYPE/);
  assert.equal(existsSync(output), false);
  rmSync(root, { recursive: true, force: true });
});

test("the bounded recovery candidate passes without changing protected files", () => {
  const recovery = join(sectionRoot, "recovery", "reviewed");
  const output = mkdtempSync(join(tmpdir(), "agentic-iac-s10-recovery-output-"));
  rmSync(output, { recursive: true });
  const result = run(process.execPath, [launcher, starter, output, "--overrides", recovery]);
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    assert.equal(report.status, "READY_FOR_HUMAN_REVIEW");
    assert.deepEqual(report.findings, []);
    assert.equal(report.apply_permitted, false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a different non-reviewer identity cannot stand in for independent approval", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-test-"));
  const recovery = join(sectionRoot, "recovery", "reviewed");
  const overrides = join(root, "reviewed");
  const copy = run("cp", ["-R", recovery, overrides]);
  assert.equal(copy.status, 0, copy.stderr);
  const path = join(overrides, "delivery-decision.json");
  const input = JSON.parse(readFileSync(path, "utf8"));
  input.approval.approved_by = "unrelated-agent";
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`);
  const output = join(tmpdir(), `agentic-iac-s10-approval-output-${process.pid}`);
  const result = run(process.execPath, [launcher, starter, output, "--overrides", overrides]);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
  assert.deepEqual(report.findings.map(({ id }) => id), ["S10_AUTHOR_SELF_APPROVAL"]);
  rmSync(output, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("any Argo automated sync block remains a primary finding", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-argo-test-"));
  const recovery = join(sectionRoot, "recovery", "reviewed");
  const overrides = join(root, "reviewed");
  const copy = run("cp", ["-R", recovery, overrides]);
  assert.equal(copy.status, 0, copy.stderr);
  const path = join(overrides, "gitops", "application.yaml");
  const source = readFileSync(path, "utf8").replace("  syncPolicy:\n", "  syncPolicy:\n    automated:\n      prune: false\n      selfHeal: false\n");
  writeFileSync(path, source);
  const output = join(tmpdir(), `agentic-iac-s10-argo-output-${process.pid}`);
  const result = run(process.execPath, [launcher, starter, output, "--overrides", overrides]);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
  assert.deepEqual(report.findings.map(({ id }) => id), ["S10_ARGO_AUTOMATION_ENABLED"]);
  rmSync(output, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("the reviewed recovery patch is valid and touches only the three decision files", () => {
  const patch = join(sectionRoot, "recovery", "reviewed.patch");
  const source = readFileSync(patch, "utf8");
  const paths = [...source.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(paths, [
    "section-10/starter/changed-files.txt",
    "section-10/starter/delivery-decision.json",
    "section-10/starter/gitops/application.yaml",
  ]);
  const checked = run("patch", ["--dry-run", "-p1", "-i", patch], { cwd: join(sectionRoot, "..") });
  assert.equal(checked.status, 0, checked.stderr);
});

test("cleanup removes only a marked evidence directory", () => {
  const { output } = evaluate();
  const result = run(process.execPath, [cleanup, output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(output), false);

  const unrelated = mkdtempSync(join(tmpdir(), "agentic-iac-s10-unrelated-"));
  const refused = run(process.execPath, [cleanup, unrelated]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /REFUSED/);
  rmSync(unrelated, { recursive: true, force: true });
});

test("the evidence schema requires the exact proof boundary", () => {
  const schema = JSON.parse(readFileSync(evidenceSchema, "utf8"));
  assert.deepEqual(schema.required, [
    "task_id",
    "status",
    "candidate_sha256",
    "findings",
    "terraform",
    "helm",
    "apply_permitted",
  ]);
});

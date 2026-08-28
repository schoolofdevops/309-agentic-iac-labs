import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const repositoryRoot = join(sectionRoot, "..");
const starter = join(sectionRoot, "starter");
const chart = join(starter, "gitops", "chart");

function run(executable, args, options = {}) {
  return spawnSync(executable, args, { cwd: sectionRoot, encoding: "utf8", shell: false, ...options });
}

test("learner documents and immutable-base evaluator artifacts exist", () => {
  for (const relative of [
    "README.md", "request.md", "task.md", "contracts/starter-review.json",
    "contracts/starter-evidence.schema.json", "scripts/run-starter-review.mjs",
    "scripts/cleanup-starter-evidence.mjs", "policy/delivery.rego",
    "starter/changed-files.txt", "starter/delivery-decision.json",
    "starter/terraform/main.tf", "starter/workflows/terraform-plan.yml",
    "starter/gitops/application.yaml",
  ]) assert.ok(existsSync(join(sectionRoot, relative)), `missing ${relative}`);
  assert.equal(existsSync(join(starter, "protected")), false, "starter must be candidate data only");
});

test("the trusted contract freezes identities, accepted paths, and Application fields", () => {
  const contract = JSON.parse(readFileSync(join(sectionRoot, "contracts", "starter-review.json"), "utf8"));
  assert.deepEqual(contract.identities, {
    author: "agent-author",
    reviewer: "human-platform-reviewer",
    delivery: "terraform-plan-workflow",
    runtime: "inference-platform-api",
  });
  assert.deepEqual(contract.accepted_changed_files, [
    "section-10/starter/gitops/application.yaml",
    "section-10/starter/terraform/main.tf",
  ]);
  assert.equal(contract.application.name, "inference-platform");
  assert.equal(contract.application.namespace, "argocd");
  assert.equal(contract.application.targetRevision, "HEAD");
});

test("the inert starter carries only the three intended delivery defects", () => {
  const workflow = readFileSync(join(starter, "workflows", "terraform-plan.yml"), "utf8");
  const changed = readFileSync(join(starter, "changed-files.txt"), "utf8");
  const decision = JSON.parse(readFileSync(join(starter, "delivery-decision.json"), "utf8"));
  const application = readFileSync(join(starter, "gitops", "application.yaml"), "utf8");
  assert.match(workflow, /^on:\n  pull_request_target:/m);
  assert.match(workflow, /permissions:\n  contents: write\n  id-token: write/);
  assert.match(changed, /workflows\/terraform-plan\.yml/);
  assert.equal(decision.approval.approved_by, "agent-author");
  assert.match(application, /automated:\n\s+prune: true\n\s+selfHeal: true/);
  assert.equal(existsSync(join(repositoryRoot, ".github", "workflows")), false);
});

test("Terraform and OpenTofu validate the narrow provider-free intent", () => {
  for (const engine of ["terraform", "tofu"]) {
    const data = mkdtempSync(join(tmpdir(), `agentic-iac-s10-${engine}-data-`));
    const env = { HOME: tmpdir(), LANG: "C", LC_ALL: "C", PATH: process.env.PATH, TF_DATA_DIR: data, TF_IN_AUTOMATION: "true" };
    const init = run(engine, ["-chdir=starter/terraform", "init", "-backend=false", "-input=false", "-no-color"], { env });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const validate = run(engine, ["-chdir=starter/terraform", "validate", "-no-color"], { env });
    assert.equal(validate.status, 0, validate.stderr || validate.stdout);
    rmSync(data, { recursive: true, force: true });
  }
});

test("the immutable chart passes Helm and the published workload policy", () => {
  const lint = run("helm", ["lint", chart]);
  assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  const rendered = run("helm", ["template", "inference-platform", chart, "--namespace", "inference"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const policy = run("conftest", ["test", "-", "--parser", "yaml", "--policy", join(repositoryRoot, "section-9", "policy"), "--output", "json"], { input: rendered.stdout });
  assert.equal(policy.status, 0, policy.stderr || policy.stdout);
  assert.doesNotMatch(rendered.stdout, /^kind: Secret$/m);
  assert.match(rendered.stdout, /name: inference-platform-backend-token/);
  assert.doesNotMatch(rendered.stdout, /^kind: NetworkPolicy$/m);
});

test("the reviewed recovery patch is valid and limited to three learner files", () => {
  const patch = join(sectionRoot, "recovery", "reviewed.patch");
  const source = readFileSync(patch, "utf8");
  assert.deepEqual([...source.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => match[1]), [
    "section-10/starter/changed-files.txt",
    "section-10/starter/delivery-decision.json",
    "section-10/starter/gitops/application.yaml",
  ]);
  const checked = run("patch", ["--dry-run", "-p1", "-i", patch], { cwd: repositoryRoot });
  assert.equal(checked.status, 0, checked.stderr);
});

test("trusted cleanup removes only directly marked evidence", () => {
  const cleanup = join(sectionRoot, "scripts", "cleanup-starter-evidence.mjs");
  const output = mkdtempSync(join(tmpdir(), "agentic-iac-s10-cleanup-"));
  writeFileSync(join(output, ".agentic-iac-s10-evidence-root"), "section-10-task-3\n");
  const result = run(process.execPath, [cleanup, output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(output), false);

  const unrelated = mkdtempSync(join(tmpdir(), "agentic-iac-s10-unrelated-"));
  mkdirSync(join(unrelated, "keep"));
  const refused = run(process.execPath, [cleanup, unrelated]);
  assert.notEqual(refused.status, 0);
  assert.ok(existsSync(unrelated));
  rmSync(unrelated, { recursive: true });
});

test("evidence schema binds both revisions and closes apply permission", () => {
  const schema = JSON.parse(readFileSync(join(sectionRoot, "contracts", "starter-evidence.schema.json"), "utf8"));
  assert.ok(schema.required.includes("trusted_revision"));
  assert.ok(schema.required.includes("candidate_revision"));
  assert.equal(schema.properties.apply_permitted.const, false);
});

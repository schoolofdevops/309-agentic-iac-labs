import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sectionRoot = join(here, "..");
const checker = join(sectionRoot, "scripts", "check-delivery-change.mjs");
const safeWorkflow = join(sectionRoot, "workflows", "terraform-plan.yml");

function checkWorkflow(contents = readFileSync(safeWorkflow, "utf8")) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-workflow-test-"));
  const workflow = join(root, "terraform-plan.yml");
  writeFileSync(workflow, contents);
  const result = spawnSync(process.execPath, [checker, "--workflow", workflow], {
    encoding: "utf8",
    shell: false,
  });
  rmSync(root, { recursive: true, force: true });
  return result;
}

function mutate(from, to) {
  const original = readFileSync(safeWorkflow, "utf8");
  const changed = original.replace(from, to);
  assert.notEqual(changed, original, `mutation did not match: ${from}`);
  return changed;
}

test("the inert reference workflow satisfies the guarded plan contract", () => {
  const result = checkWorkflow();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /READY_FOR_HUMAN_REVIEW/);
});

const rejectedMutations = [
  ["changes read-only permissions to write-all", "permissions:\n  contents: read", "permissions: write-all", "WRITE_PERMISSION"],
  ["uses pull_request_target", "  pull_request:", "  pull_request_target:", "UNSAFE_EVENT"],
  ["removes pull_request", "  pull_request:", "  workflow_dispatch:", "PULL_REQUEST_REQUIRED"],
  ["uses an unpinned action", /uses: actions\/checkout@[0-9a-f]{40}/, "uses: actions/checkout@v7", "UNPINNED_ACTION"],
  ["exposes a secret", "TF_IN_AUTOMATION: \"true\"", "TF_IN_AUTOMATION: ${{ secrets.TF_TOKEN }}", "SECRET_ACCESS"],
  ["adds apply", "terraform-plan", "terraform-apply", "APPLY_DESTROY_FORBIDDEN"],
  ["adds destroy", "terraform-plan", "terraform-destroy", "APPLY_DESTROY_FORBIDDEN"],
  ["removes concurrency", /concurrency:\n  group: [^\n]+\n  cancel-in-progress: true\n/, "", "CONCURRENCY_REQUIRED"],
  ["makes artifact retention unbounded", "retention-days: 7", "retention-days: 91", "ARTIFACT_RETENTION"],
  ["interpolates event data into a shell command", "node section-10/scripts/run-reviewed-plan.mjs", "echo ${{ github.event.pull_request.title }}\n          node section-10/scripts/run-reviewed-plan.mjs", "SHELL_INTERPOLATION"],
];

for (const [name, from, to, code] of rejectedMutations) {
  test(name, () => {
    const result = checkWorkflow(mutate(from, to));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(code));
  });
}


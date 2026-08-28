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
  ["changes read-only permissions to write-all", "permissions:\n  contents: read", "permissions: write-all", "WORKFLOW_INVARIANT"],
  ["uses pull_request_target", "  pull_request:", "  pull_request_target:", "WORKFLOW_INVARIANT"],
  ["removes pull_request", "  pull_request:", "  workflow_dispatch:", "WORKFLOW_INVARIANT"],
  ["uses an unpinned action", /uses: actions\/checkout@[0-9a-f]{40}/, "uses: actions/checkout@v7", "WORKFLOW_INVARIANT"],
  ["exposes a secret", "TF_IN_AUTOMATION: \"true\"", "TF_IN_AUTOMATION: ${{ secrets.TF_TOKEN }}", "WORKFLOW_INVARIANT"],
  ["adds apply", "terraform-plan", "terraform-apply", "WORKFLOW_INVARIANT"],
  ["adds destroy", "terraform-plan", "terraform-destroy", "WORKFLOW_INVARIANT"],
  ["removes concurrency", /concurrency:\n  group: [^\n]+\n  cancel-in-progress: true\n/, "", "WORKFLOW_INVARIANT"],
  ["makes artifact retention unbounded", "retention-days: 7", "retention-days: 91", "WORKFLOW_INVARIANT"],
  ["interpolates event data into a shell command", "node trusted/section-10/scripts/run-reviewed-plan.mjs", "echo ${{ github.event.pull_request.title }}\n          node trusted/section-10/scripts/run-reviewed-plan.mjs", "WORKFLOW_INVARIANT"],
  ["hides pull_request in a decoy scalar", "on:\n  pull_request:", "x-decoy: |\n  pull_request:\non:\n  workflow_dispatch:", "WORKFLOW_INVARIANT"],
  ["uses an attacker action with an official pin in a comment", /uses: actions\/checkout@[0-9a-f]{40}/, "uses: attacker/example@main # actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "WORKFLOW_INVARIANT"],
  ["uses an arbitrary attacker action pinned to forty hex characters", /uses: actions\/checkout@[0-9a-f]{40}/, `uses: attacker/example@${"a".repeat(40)}`, "WORKFLOW_INVARIANT"],
  ["uses bracket-style secret access", "TF_IN_AUTOMATION: \"true\"", "TF_IN_AUTOMATION: ${{ secrets['TF_TOKEN'] }}", "WORKFLOW_INVARIANT"],
  ["uploads the filesystem root", "path: /tmp/agentic-iac-s10-plan-evidence", "path: /", "WORKFLOW_INVARIANT"],
  ["places an event expression in run", "node trusted/section-10/scripts/run-reviewed-plan.mjs", "echo ${{ github.event.pull_request.title }}\n          node trusted/section-10/scripts/run-reviewed-plan.mjs", "WORKFLOW_INVARIANT"],
  ["removes checkout credential disabling", "          persist-credentials: false", "          persist-credentials: true", "WORKFLOW_INVARIANT"],
  ["moves artifact bounds outside the upload step", "          path: /tmp/agentic-iac-s10-plan-evidence\n          if-no-files-found: error\n          retention-days: 7", "          path: /tmp/decoy\n\n      - name: Decoy artifact text\n        env:\n          NOTE: 'path: /tmp/agentic-iac-s10-plan-evidence retention-days: 7 if-no-files-found: error'\n        run: echo decoy", "WORKFLOW_INVARIANT"],
];

for (const [name, from, to, code] of rejectedMutations) {
  test(name, () => {
    const result = checkWorkflow(mutate(from, to));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(code));
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const approvalCli = new URL("../scripts/approve-gitops-revision.mjs", import.meta.url);
const openerCli = new URL("../scripts/open-gitops-approval-gate.mjs", import.meta.url);

test("no imported production module exposes an approval publisher", () => {
  const probe = `
    const approval = await import(${JSON.stringify(approvalCli.href)});
    const opener = await import(${JSON.stringify(openerCli.href)});
    const expected = [
      "APPROVAL_MARKER_BYTES", "APPROVAL_MARKER_NAME", "V1_APPROVAL_MESSAGE", "V1_APPROVAL_TAG",
      "assertApprovalBoundaryUnchanged", "bindApprovalBoundary", "inspectGitCandidate",
      "validateRecoveryPersistence", "validateRuntimeSnapshot",
    ];
    if (Object.keys(approval).length || JSON.stringify(Object.keys(opener)) !== JSON.stringify(expected)) {
      throw new Error(\`UNEXPECTED_APPROVAL_EXPORT: \${[...Object.keys(approval), ...Object.keys(opener)].join(",")}\`);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the foreground CLI owns failure cleanup with the retained gate binding", () => {
  const source = readFileSync(openerCli, "utf8");
  assert.match(source, /gateOwnership:\s*gate\.ownership/);
  assert.match(source, /result\?\.gateOwnership && !approvalPublished/);
  assert.match(source, /removeOwnedApprovalGate\(result\.gateOwnership\)/);
  assert.doesNotMatch(source, /from "\.\/approve-gitops-revision\.mjs"/);
});

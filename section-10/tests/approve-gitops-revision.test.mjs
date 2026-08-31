import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const guard = new URL("../scripts/approve-gitops-revision.mjs", import.meta.url);
const opener = new URL("../scripts/open-gitops-approval-gate.mjs", import.meta.url);

test("the legacy approval module exports no callable surface", () => {
  const probe = `const value = await import(${JSON.stringify(guard.href)}); if (Object.keys(value).length !== 0) process.exit(9);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the private foreground publisher accepts no injected streams or hooks", () => {
  const source = readFileSync(opener, "utf8");
  assert.match(source, /async function completeInteractiveApproval\(\{ gateBinding, output, purpose, revision \}\)/);
  assert.match(source, /createInterface\(\{ input: process\.stdin/);
  assert.doesNotMatch(source, /export (?:async )?function (?:complete|publish|write)/);
  assert.doesNotMatch(source, /\bafterPublish\b|\boutputStream\b|\btimeoutMs\b/);
});

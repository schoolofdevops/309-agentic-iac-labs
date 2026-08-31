import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const challenge = readFileSync(new URL("../challenge/task.md", import.meta.url), "utf8");

test("diagnostics waits for Argo to report Degraded before recovery approval", () => {
  const wait = "-n argocd wait \\\n  --for=jsonpath='{.status.health.status}'=Degraded";
  const applicationEvidence = "get application inference-platform";
  assert.ok(challenge.includes(wait), "the live Application health projection must settle before the gate runs");
  assert.ok(challenge.indexOf(wait) < challenge.indexOf(applicationEvidence), "wait before displaying Application evidence");
});

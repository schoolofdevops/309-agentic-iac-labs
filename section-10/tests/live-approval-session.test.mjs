import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as approval from "../scripts/approve-gitops-revision.mjs";
import { openApprovalGate } from "../scripts/run-gitops-lifecycle.mjs";

const revision = "2".repeat(40);
const purpose = "promote-v2";
const observed = { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "1".repeat(40) };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-live-approval."));
  const output = join(root, "approval.json");
  const opened = openApprovalGate(output, revision, purpose, observed);
  return { gate: opened.binding.path, gateBinding: opened.binding, output, root };
}

async function interaction(input, typed, { beforeInput, timeoutMs = 2_000 } = {}) {
  assert.equal(typeof approval.completeInteractiveApproval, "function", "foreground live-holder API is required");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let displayed = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => { displayed += chunk; });
  const completion = approval.completeInteractiveApproval({
    gateBinding: input.gateBinding,
    input: stdin,
    output: input.output,
    outputStream: stdout,
    purpose,
    revision,
    timeoutMs,
  }).then((value) => ({ value }), (error) => ({ error }));
  if (beforeInput) await beforeInput();
  if (typed != null) stdin.end(typed);
  const outcome = await completion;
  stdin.destroy();
  stdout.destroy();
  return { displayed, ...outcome };
}

function replaceGate(input, priorRevision = observed.revision, replacement = "rename") {
  const alternate = join(input.root, `alternate-${priorRevision[0]}.gate.json`);
  const value = JSON.parse(readFileSync(input.gate, "utf8"));
  value.observed.revision = priorRevision;
  writeFileSync(alternate, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (replacement === "rename") renameSync(input.gate, join(input.root, "original.gate.json"));
  else rmSync(input.gate);
  renameSync(alternate, input.gate);
}

test("foreground holder completes one exact human approval input", async () => {
  const input = fixture();
  try {
    const result = await interaction(input, `approve ${revision}\n`);
    assert.equal(result.error, undefined);
    assert.equal(result.displayed, `Approval> type exactly: approve ${revision}\n`);
    assert.equal(result.value.revision, revision);
    assert.equal(result.value.purpose, purpose);
    assert.equal(existsSync(input.output), true);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("foreground holder rejects wrong approval text and revision", async () => {
  for (const typed of [`yes ${revision}\n`, `approve ${"3".repeat(40)}\n`]) {
    const input = fixture();
    try {
      const result = await interaction(input, typed);
      assert.match(result.error?.message ?? "", /HUMAN_APPROVAL_INPUT_INVALID/);
      assert.equal(existsSync(input.output), false);
    } finally { rmSync(input.root, { recursive: true, force: true }); }
  }
});

test("foreground holder rejects EOF without approval input", async () => {
  const input = fixture();
  try {
    const result = await interaction(input, "");
    assert.match(result.error?.message ?? "", /HUMAN_APPROVAL_INPUT_EOF/);
    assert.equal(existsSync(input.output), false);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("foreground holder times out without approval input", async () => {
  const input = fixture();
  try {
    const result = await interaction(input, null, { timeoutMs: 25 });
    assert.match(result.error?.message ?? "", /HUMAN_APPROVAL_INPUT_TIMEOUT/);
    assert.equal(existsSync(input.output), false);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("foreground holder rejects unlink and rename gate replacement during the prompt", async () => {
  for (const replacement of ["unlink", "rename"]) {
    const input = fixture();
    try {
      const result = await interaction(input, `approve ${revision}\n`, {
        beforeInput: () => replaceGate(input, observed.revision, replacement),
      });
      assert.match(result.error?.message ?? "", /APPROVAL_GATE_CHANGED/);
      assert.equal(existsSync(input.output), false);
    } finally { rmSync(input.root, { recursive: true, force: true }); }
  }
});

test("forged gate and approval files cannot make the live holder succeed", async () => {
  const input = fixture();
  try {
    const forged = `${JSON.stringify({
      schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author",
      revision, purpose, approved: true,
    })}\n`;
    const result = await interaction(input, `approve ${revision}\n`, {
      beforeInput: () => {
        replaceGate(input, "3".repeat(40));
        writeFileSync(input.output, forged, { mode: 0o600 });
      },
    });
    assert.match(result.error?.message ?? "", /APPROVAL_GATE_CHANGED|APPROVAL_OUTPUT_EXISTS/);
    assert.equal(result.value, undefined);
    assert.equal(readFileSync(input.output, "utf8"), forged);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("production approval code contains no socket or serialized handoff protocol", () => {
  const source = readFileSync(new URL("../scripts/approve-gitops-revision.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createServer|createConnection|\.sock|binding\.json|GateHandoff/);
});

test("standalone approval CLI cannot bypass the foreground binding holder", () => {
  const cli = new URL("../scripts/approve-gitops-revision.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Approval not written: LIVE_HOLDER_REQUIRED. Use the foreground gate opener.\n");
});

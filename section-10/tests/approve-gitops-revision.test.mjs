import assert from "node:assert/strict";
import {
  existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { assertApprovedRevision, openApprovalGate, readApprovalGateBinding } from "../scripts/run-gitops-lifecycle.mjs";
import { completeInteractiveApproval, readApprovalGate } from "../scripts/approve-gitops-revision.mjs";

function gateFor(root, { revision = "2".repeat(40), purpose = "promote-v2" } = {}) {
  const output = join(root, "approval.json");
  const observed = purpose === "promote-v2"
    ? { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "1".repeat(40) }
    : { sync: "OutOfSync", replicas_after_15_seconds: 2 };
  const opened = openApprovalGate(output, revision, purpose, observed);
  return { output, gate: opened.binding.path, gateBinding: opened.binding, revision, purpose };
}

async function approve(input, hooks = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.end(`approve ${input.revision}\n`);
  const result = await completeInteractiveApproval({
    ...input, input: stdin, outputStream: stdout, timeoutMs: 2_000,
  }, hooks);
  stdin.destroy();
  stdout.destroy();
  return result;
}

test("foreground holder writes the exact six-field approval record", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-record-"));
  try {
    const input = gateFor(root);
    const result = await approve(input);
    assert.equal(result.revision, input.revision);
    assert.equal(readFileSync(input.output, "utf8"), `${JSON.stringify({
      schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author",
      revision: input.revision, purpose: input.purpose, approved: true,
    })}\n`);
    assert.equal(lstatSync(input.output).mode & 0o777, 0o600);
    assert.doesNotThrow(() => assertApprovedRevision(input.output, input.revision, input.purpose));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holder rejects mismatched revision, purpose, and output boundary before prompting", async () => {
  for (const changed of [
    { revision: "f".repeat(40) },
    { purpose: "revert-and-recover" },
    { output: "outside.json" },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-mismatch-"));
    try {
      const input = gateFor(root);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      await assert.rejects(completeInteractiveApproval({
        ...input,
        ...changed,
        input: stdin,
        output: changed.output ? join(root, changed.output) : input.output,
        outputStream: stdout,
        timeoutMs: 100,
      }), /UNAPPROVED_REVISION|APPROVAL_PURPOSE_MISMATCH|APPROVAL_PATH_FORBIDDEN/);
      assert.equal(existsSync(input.output), false);
      stdin.destroy();
      stdout.destroy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("holder refuses stale and malformed gates before prompting", async () => {
  for (const mutate of [
    (gate, input) => { gate.observed.revision = input.revision; },
    (gate) => { gate.schema = "other/v1"; },
    (gate) => { gate.observed.health = "Degraded"; },
    (gate) => { gate.purpose = "promote-v1"; },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-invalid-gate-"));
    try {
      const input = gateFor(root);
      const gate = JSON.parse(readFileSync(input.gate, "utf8"));
      mutate(gate, input);
      writeFileSync(input.gate, `${JSON.stringify(gate)}\n`, { mode: 0o600 });
      const gateBinding = readApprovalGateBinding(input.gate);
      await assert.rejects(approve({ ...input, gateBinding }), /APPROVAL_GATE_INVALID/);
      assert.equal(existsSync(input.output), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("holder rejects existing output and a symlinked approval boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-output-safety-"));
  const target = mkdtempSync(join(tmpdir(), "agentic-iac-s10-output-target-"));
  try {
    const input = gateFor(root);
    writeFileSync(input.output, "do not overwrite\n", { mode: 0o600 });
    await assert.rejects(approve(input), /APPROVAL_OUTPUT_EXISTS/);
    assert.equal(readFileSync(input.output, "utf8"), "do not overwrite\n");

    const targetInput = gateFor(target);
    const linked = join(root, "linked-approval-directory");
    symlinkSync(target, linked);
    await assert.rejects(approve({
      ...targetInput,
      gateBinding: { ...targetInput.gateBinding, path: join(linked, "approval.json.gate.json") },
      output: join(linked, "approval.json"),
    }), /APPROVAL_GATE_CHANGED|SYMLINK_PATH_FORBIDDEN/);
    assert.equal(existsSync(targetInput.output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("gate reads fail closed on changed identity and unexpected owner", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-race-"));
  try {
    const input = gateFor(root);
    assert.throws(() => readApprovalGate(input.gate, {
      readFile: (descriptor, encoding) => {
        const raw = readFileSync(descriptor, encoding);
        writeFileSync(input.gate, `${raw} `, { mode: 0o600 });
        return raw;
      },
    }), /APPROVAL_GATE_(?:INVALID|CHANGED)/);
    rmSync(input.gate);
    const next = gateFor(root);
    assert.throws(() => readApprovalGate(next.gate, {
      fstat: (descriptor) => {
        const metadata = fstatSync(descriptor);
        return new Proxy(metadata, { get: (target, key) => key === "uid" ? target.uid + 1 : Reflect.get(target, key, target) });
      },
    }), /APPROVAL_GATE_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holder rejects a gate substituted after publication and removes its output", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-holder-gate-swap-"));
  try {
    const input = gateFor(root);
    const original = readFileSync(input.gate, "utf8");
    await assert.rejects(approve(input, {
      afterPublish: () => {
        rmSync(input.gate);
        writeFileSync(input.gate, original, { mode: 0o600 });
      },
    }), /APPROVAL_GATE_CHANGED/);
    assert.equal(existsSync(input.output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holder rejects a same-byte approval replacement without removing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-holder-output-swap-"));
  try {
    const input = gateFor(root);
    const approvedBytes = `${JSON.stringify({
      schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author",
      revision: input.revision, purpose: input.purpose, approved: true,
    })}\n`;
    await assert.rejects(approve(input, {
      afterPublish: () => {
        rmSync(input.output);
        writeFileSync(input.output, approvedBytes, { mode: 0o600 });
      },
    }), /APPROVAL_OUTPUT_CHANGED/);
    assert.equal(readFileSync(input.output, "utf8"), approvedBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holder rejects an approval symlink replacement after publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-holder-output-link-"));
  const target = mkdtempSync(join(tmpdir(), "agentic-iac-s10-holder-output-target-"));
  try {
    const input = gateFor(root);
    await assert.rejects(approve(input, {
      afterPublish: () => {
        rmSync(input.output);
        symlinkSync(join(target, "foreign.json"), input.output);
      },
    }), /APPROVAL_RECORD_INVALID/);
    assert.equal(lstatSync(input.output).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("holder rejects an approval-directory swap and leaves no temporary file", async () => {
  const outer = mkdtempSync(join(tmpdir(), "agentic-iac-s10-holder-parent-swap-"));
  const root = join(outer, "approval-directory");
  mkdirSync(root);
  try {
    const input = gateFor(root);
    const moved = `${root}-moved`;
    await assert.rejects(approve(input, {
      afterPublish: () => {
        renameSync(root, moved);
        mkdirSync(root);
      },
    }), /APPROVAL_GATE_CHANGED/);
    assert.equal(existsSync(input.output), false);
    assert.equal(readdirSync(moved).some((name) => name.endsWith(".tmp")), false);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

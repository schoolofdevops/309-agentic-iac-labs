import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertApprovedRevision } from "../scripts/run-gitops-lifecycle.mjs";
import { createApprovalFromGate, readApprovalGate } from "../scripts/approve-gitops-revision.mjs";

const cli = new URL("../scripts/approve-gitops-revision.mjs", import.meta.url);

function gateFor(root, { revision = "2".repeat(40), purpose = "promote-v2" } = {}) {
  const output = join(root, "approval.json");
  const observed = purpose === "promote-v2"
    ? { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "1".repeat(40) }
    : { sync: "OutOfSync", replicas_after_15_seconds: 2 };
  writeFileSync(`${output}.gate.json`, `${JSON.stringify({
    schema: "agentic-iac-s10-approval-gate/v1", purpose, revision,
    opened_at: "2026-08-31T00:00:00.000Z", observed,
  })}\n`, { mode: 0o600 });
  return { output, gate: `${output}.gate.json`, revision, purpose };
}

function run({ gate, output, revision, purpose }, extra = []) {
  return spawnSync(process.execPath, [cli.pathname, "--gate", gate, "--output", output, "--revision", revision, "--purpose", purpose, ...extra], { encoding: "utf8" });
}

test("learner CLI writes the exact runner-approved six-field record", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-learner-approval-"));
  try {
    const input = gateFor(root);
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Approved revision ${input.revision} for ${input.purpose}.\n`);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(input.output, "utf8"), `${JSON.stringify({
      schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author",
      revision: input.revision, purpose: input.purpose, approved: true,
    })}\n`);
    assert.equal(lstatSync(input.output).mode & 0o777, 0o600);
    assert.doesNotThrow(() => assertApprovedRevision(input.output, input.revision, input.purpose));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learner CLI rejects a stale promote gate that does not describe the prior revision", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-stale-approval-gate-"));
  try {
    const input = gateFor(root);
    const gate = JSON.parse(readFileSync(input.gate, "utf8"));
    gate.observed.revision = input.revision;
    writeFileSync(input.gate, `${JSON.stringify(gate)}\n`, { mode: 0o600 });
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPROVAL_GATE_INVALID/);
    assert.equal(lstatSync(input.output, { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learner CLI rejects mismatched revision or purpose, unknown flags, and an output outside its gate boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-approval-inputs-"));
  try {
    const input = gateFor(root);
    for (const [changed, expected] of [
      [{ ...input, revision: "f".repeat(40) }, /UNAPPROVED_REVISION/],
      [{ ...input, purpose: "revert-and-recover" }, /APPROVAL_PURPOSE_MISMATCH/],
      [{ ...input, output: join(root, "outside.json") }, /APPROVAL_PATH_FORBIDDEN/],
    ]) {
      const result = run(changed);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(existsSync(input.output), false);
    }
    const extra = run(input, ["--unexpected", "value"]);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /USAGE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learner CLI refuses malformed gates, invalid observed states, and gate-output confusion", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-invalid-gate-"));
  try {
    const input = gateFor(root);
    for (const mutate of [
      (gate) => { gate.schema = "other/v1"; },
      (gate) => { gate.observed.health = "Degraded"; },
      (gate) => { gate.purpose = "promote-v1"; },
    ]) {
      const gate = JSON.parse(readFileSync(input.gate, "utf8"));
      mutate(gate);
      writeFileSync(input.gate, `${JSON.stringify(gate)}\n`, { mode: 0o600 });
      const result = run(input);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /APPROVAL_GATE_INVALID/);
      assert.equal(existsSync(input.output), false);
      rmSync(input.gate);
      gateFor(root);
    }
    const confused = run({ ...input, gate: input.output });
    assert.notEqual(confused.status, 0);
    assert.match(confused.stderr, /APPROVAL_GATE_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learner CLI rejects existing outputs and any learner-controlled symlink ancestor", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-output-safety-"));
  const target = mkdtempSync(join(tmpdir(), "agentic-iac-s10-output-target-"));
  try {
    const input = gateFor(root);
    writeFileSync(input.output, "do not overwrite\n", { mode: 0o600 });
    const existing = run(input);
    assert.notEqual(existing.status, 0);
    assert.match(existing.stderr, /APPROVAL_OUTPUT_EXISTS/);
    assert.equal(readFileSync(input.output, "utf8"), "do not overwrite\n");

    const linked = join(root, "linked-approval-directory");
    const targetInput = gateFor(target);
    symlinkSync(target, linked);
    const symlinked = run({ ...targetInput, gate: join(linked, "approval.json.gate.json"), output: join(linked, "approval.json") });
    assert.notEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /SYMLINK_PATH_FORBIDDEN/);
    assert.equal(existsSync(targetInput.output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("gate reads fail closed on changed identity and an unexpected owner", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-race-"));
  try {
    const input = gateFor(root);
    assert.throws(() => readApprovalGate(input.gate, {
      readFile: (_descriptor, encoding) => {
        const raw = readFileSync(input.gate, encoding);
        writeFileSync(input.gate, `${raw} `, { mode: 0o600 });
        return raw;
      },
    }), /APPROVAL_GATE_CHANGED_DURING_READ/);
    gateFor(root);
    assert.throws(() => readApprovalGate(input.gate, {
      lstat: (path) => {
        const metadata = lstatSync(path);
        return path === input.gate ? new Proxy(metadata, { get: (target, key) => key === "uid" ? target.uid + 1 : Reflect.get(target, key, target) }) : metadata;
      },
    }), /APPROVAL_GATE_OWNER_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper rejects a gate substituted after it stages an approval and removes its output", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-helper-gate-swap-"));
  try {
    const input = gateFor(root);
    const original = readFileSync(input.gate, "utf8");
    assert.throws(() => createApprovalFromGate(input, {
      afterPublish: () => {
        rmSync(input.gate);
        writeFileSync(input.gate, original, { mode: 0o600 });
      },
    }), /APPROVAL_GATE_CHANGED/);
    assert.equal(existsSync(input.output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper rejects a same-byte regular-file approval replacement after publish without removing it", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-helper-same-byte-swap-"));
  try {
    const input = gateFor(root);
    const approvedBytes = `${JSON.stringify({
      schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer", requested_by: "agent-author",
      revision: input.revision, purpose: input.purpose, approved: true,
    })}\n`;
    assert.throws(() => createApprovalFromGate(input, {
      afterPublish: () => {
        rmSync(input.output);
        writeFileSync(input.output, approvedBytes, { mode: 0o600 });
      },
    }), /APPROVAL_OUTPUT_CHANGED/);
    assert.equal(readFileSync(input.output, "utf8"), approvedBytes);
    assert.equal(lstatSync(input.output).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper rejects a substituted output path after staging without overwriting it", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-helper-output-swap-"));
  const target = mkdtempSync(join(tmpdir(), "agentic-iac-s10-helper-output-target-"));
  try {
    const input = gateFor(root);
    assert.throws(() => createApprovalFromGate(input, {
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

test("helper rejects an approval-directory swap after staging and leaves no temporary file", () => {
  const outer = mkdtempSync(join(tmpdir(), "agentic-iac-s10-helper-parent-swap-"));
  const root = join(outer, "approval-directory");
  mkdirSync(root);
  try {
    const input = gateFor(root);
    const moved = `${root}-moved`;
    assert.throws(() => createApprovalFromGate(input, {
      afterPublish: () => {
        renameSync(root, moved);
        mkdirSync(root);
      },
    }), /APPROVAL_GATE_CHANGED/);
    assert.equal(existsSync(input.output), false);
    assert.equal(readdirSync(moved).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

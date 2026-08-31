import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const opener = new URL("../scripts/open-gitops-approval-gate.mjs", import.meta.url);
const loader = new URL("./fixtures/approval-opener-loader.mjs", import.meta.url);
const revision = "2".repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-human.test."));
  chmodSync(root, 0o700);
  const approvals = join(root, "approvals");
  mkdirSync(approvals, { mode: 0o700 });
  const output = join(approvals, "v2.json");
  return { gate: `${output}.gate.json`, output, root };
}

function cliArgs(input) {
  return [
    "--no-warnings", "--experimental-loader", loader.pathname, opener.pathname,
    "--source", input.root, "--revision", revision,
    "--approval", input.output, "--purpose", "promote-v2",
  ];
}

function runCli(input, humanInput) {
  return spawnSync(process.execPath, cliArgs(input), { encoding: "utf8", input: humanInput });
}

function startCli(input) {
  const child = spawn(process.execPath, cliArgs(input), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolvePromise) => child.once("close", (status) => resolvePromise({ status, stderr, stdout })));
  const prompted = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`PROMPT_NOT_OBSERVED: ${stdout}\n${stderr}`)), 2_000);
    child.stdout.on("data", () => {
      if (!stdout.includes("Approval> type exactly:")) return;
      clearTimeout(timeout);
      resolvePromise();
    });
  });
  return { child, closed, prompted };
}

function assertSuccessfulApproval(input, result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Approval> type exactly: approve ${revision}`));
  assert.match(result.stdout, new RegExp(`Approved revision ${revision} for promote-v2\\.`));
  assert.equal(JSON.parse(readFileSync(input.output, "utf8")).revision, revision);
}

test("wrong text removes the unchanged owned gate and an immediate retry succeeds", () => {
  const input = fixture();
  try {
    const rejected = runCli(input, `approve ${"3".repeat(40)}\n`);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /HUMAN_APPROVAL_INPUT_INVALID/);
    assert.doesNotMatch(rejected.stdout, /Approved revision/);
    assert.equal(existsSync(input.gate), false);
    assert.equal(existsSync(input.output), false);
    assertSuccessfulApproval(input, runCli(input, `approve ${revision}\n`));
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("EOF removes the unchanged owned gate and an immediate retry succeeds", () => {
  const input = fixture();
  try {
    const rejected = runCli(input, "");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /HUMAN_APPROVAL_INPUT_EOF/);
    assert.equal(existsSync(input.gate), false);
    assert.equal(existsSync(input.output), false);
    assertSuccessfulApproval(input, runCli(input, `approve ${revision}\n`));
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("timeout removes the unchanged owned gate and an immediate retry succeeds", async () => {
  const input = fixture();
  try {
    const running = startCli(input);
    await running.prompted;
    const rejected = await running.closed;
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /HUMAN_APPROVAL_INPUT_TIMEOUT/);
    assert.equal(existsSync(input.gate), false);
    assert.equal(existsSync(input.output), false);
    assertSuccessfulApproval(input, runCli(input, `approve ${revision}\n`));
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("a foreign gate replacement during the prompt is preserved and cannot approve", async () => {
  const input = fixture();
  try {
    const running = startCli(input);
    await running.prompted;
    const original = readFileSync(input.gate, "utf8");
    renameSync(input.gate, `${input.gate}.original`);
    writeFileSync(input.gate, original, { mode: 0o600 });
    const foreign = readFileSync(input.gate, "utf8");
    running.child.stdin.end(`approve ${revision}\n`);
    const rejected = await running.closed;
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /APPROVAL_GATE_CHANGED|APPROVAL_GATE_OWNERSHIP_CHANGED/);
    assert.doesNotMatch(rejected.stdout, /Approved revision/);
    assert.equal(readFileSync(input.gate, "utf8"), foreign);
    assert.equal(existsSync(input.output), false);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("forged gate and approval files cannot produce an accepted CLI result", async () => {
  const input = fixture();
  try {
    const running = startCli(input);
    await running.prompted;
    const gate = JSON.parse(readFileSync(input.gate, "utf8"));
    gate.observed.revision = "3".repeat(40);
    renameSync(input.gate, `${input.gate}.original`);
    writeFileSync(input.gate, `${JSON.stringify(gate)}\n`, { mode: 0o600 });
    const forged = `${JSON.stringify({
      schema: "agentic-iac-s10-human-approval/v1", approved_by: "human-platform-reviewer",
      requested_by: "agent-author", revision, purpose: "promote-v2", approved: true,
    })}\n`;
    writeFileSync(input.output, forged, { mode: 0o600 });
    running.child.stdin.end(`approve ${revision}\n`);
    const rejected = await running.closed;
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stdout, /Approved revision/);
    assert.match(rejected.stderr, /APPROVAL_GATE_CHANGED|APPROVAL_GATE_OWNERSHIP_CHANGED/);
    assert.equal(readFileSync(input.output, "utf8"), forged);
    assert.equal(JSON.parse(readFileSync(input.gate, "utf8")).observed.revision, "3".repeat(40));
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("the legacy standalone CLI remains a non-publishing guard", () => {
  const cli = new URL("../scripts/approve-gitops-revision.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Approval not written: LIVE_HOLDER_REQUIRED. Use the foreground gate opener.\n");
});

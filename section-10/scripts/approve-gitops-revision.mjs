#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync,
  linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  HUMAN_APPROVAL_IDENTITIES,
  HUMAN_APPROVAL_SCHEMA,
  assertApprovalGateBinding,
  assertApprovedRevision,
  readApprovalGateBinding,
} from "./run-gitops-lifecycle.mjs";

const GATE_SCHEMA = "agentic-iac-s10-approval-gate/v1";
const GATE_SUFFIX = ".gate.json";
const GATE_KEYS = ["observed", "opened_at", "purpose", "revision", "schema"];
const FROZEN_PURPOSES = Object.freeze({
  "promote-v2": (observed) => sameKeys(observed, ["health", "operation", "revision", "sync"])
    && observed.sync === "Synced" && observed.health === "Healthy" && observed.operation === "Succeeded"
    && isRevision(observed.revision),
  "revert-and-recover": (observed) => sameKeys(observed, ["replicas_after_15_seconds", "sync"])
    && observed.sync === "OutOfSync" && observed.replicas_after_15_seconds === 2,
});

function fail(code) { throw new Error(code); }
function sameKeys(value, keys) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function isRevision(value) { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function sha256(raw) { return createHash("sha256").update(raw).digest("hex"); }
function approvalOutputIdentity(metadata, raw) {
  return {
    device: String(metadata.dev), inode: String(metadata.ino), bytes: metadata.size,
    owner: String(metadata.uid), group: String(metadata.gid), mode: metadata.mode & 0o777,
    ctime_ms: metadata.ctimeMs, mtime_ms: metadata.mtimeMs, identity_sha256: sha256(raw),
  };
}
function sameOutputNode(left, right) {
  return left.device === right.device && left.inode === right.inode && left.bytes === right.bytes
    && left.owner === right.owner && left.group === right.group && left.mode === right.mode
    && left.identity_sha256 === right.identity_sha256;
}
function sameOutputIdentity(left, right) {
  return sameOutputNode(left, right) && left.ctime_ms === right.ctime_ms && left.mtime_ms === right.mtime_ms;
}

function readNoFollowApprovalOutput(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) fail("APPROVAL_RECORD_INVALID");
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || !sameIdentity(before, opened)) fail("APPROVAL_RECORD_CHANGED_DURING_READ");
    const raw = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (!after.isFile() || (after.mode & 0o777) !== 0o600 || !sameIdentity(opened, after)) fail("APPROVAL_RECORD_CHANGED_DURING_READ");
    const pathname = lstatSync(path);
    if (!pathname.isFile() || pathname.isSymbolicLink() || !sameIdentity(after, pathname)) fail("APPROVAL_RECORD_CHANGED_DURING_READ");
    return approvalOutputIdentity(after, raw);
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

function validateGateBinding(binding) {
  let current;
  try { current = assertApprovalGateBinding(binding); } catch { fail("APPROVAL_GATE_CHANGED"); }
  if (current.file.mode !== 0o600) fail("APPROVAL_GATE_INVALID");
  if (typeof process.getuid === "function" && current.file.owner !== String(process.getuid())) fail("APPROVAL_GATE_OWNER_INVALID");
  const value = current.gate;
  if (!sameKeys(value, GATE_KEYS) || value.schema !== GATE_SCHEMA || !isRevision(value.revision)
    || typeof value.purpose !== "string" || typeof value.opened_at !== "string"
    || !Number.isFinite(Date.parse(value.opened_at)) || !Object.hasOwn(FROZEN_PURPOSES, value.purpose)
    || !FROZEN_PURPOSES[value.purpose](value.observed)
    || (value.purpose === "promote-v2" && value.observed.revision === value.revision)) fail("APPROVAL_GATE_INVALID");
  return current;
}

export function readApprovalGate(path, options = {}) {
  let binding;
  const bindingOptions = { ...options, ...(options.readFile ? { read: options.readFile } : {}) };
  try { binding = readApprovalGateBinding(path, bindingOptions); } catch (error) {
    if (error?.message === "APPROVAL_GATE_ANCESTOR_CHANGED") fail("SYMLINK_PATH_FORBIDDEN");
    if (/^APPROVAL_GATE_(?:PARENT_|BINDING_)?CHANGED/.test(error?.message ?? "")) fail("APPROVAL_GATE_CHANGED");
    fail("APPROVAL_GATE_INVALID");
  }
  const current = validateGateBinding(binding);
  return { path: current.path, metadata: current.file, value: current.gate, binding: current };
}

function rejectSymlinkAncestors(path) {
  const values = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    values.unshift(current);
    if (current === dirname(current)) break;
  }
  for (const value of values) {
    if (!existsSync(value)) continue;
    const metadata = lstatSync(value);
    const allowedAlias = ({ "/tmp": "/private/tmp", "/var": "/private/var" })[value];
    if (metadata.isSymbolicLink() && (!allowedAlias || realpathSync(value) !== allowedAlias)) fail("SYMLINK_PATH_FORBIDDEN");
  }
}

function approvalPath(gate, output) {
  const gatePath = resolve(gate);
  const requestedOutput = resolve(output);
  rejectSymlinkAncestors(gatePath);
  rejectSymlinkAncestors(requestedOutput);
  if (!gatePath.endsWith(GATE_SUFFIX) || requestedOutput !== gatePath.slice(0, -GATE_SUFFIX.length)
    || dirname(requestedOutput) !== dirname(gatePath)) fail("APPROVAL_PATH_FORBIDDEN");
  return requestedOutput;
}

function createTemporaryApproval(output, bytes) {
  const directory = dirname(output);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporary = resolve(directory, `.${parse(output).base}.${randomBytes(16).toString("hex")}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, bytes, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      return temporary;
    } catch (error) {
      if (descriptor != null) {
        try { closeSync(descriptor); } catch { /* Preserve the original failure. */ }
      }
      try { unlinkSync(temporary); } catch { /* Best effort. */ }
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("APPROVAL_TEMPORARY_CREATE_FAILED");
}

function removeOnlyCreatedOutput(path, expected) {
  try {
    if (sameOutputIdentity(readNoFollowApprovalOutput(path), expected)) unlinkSync(path);
  } catch { /* Never remove a replacement. */ }
}

function publishApprovalFromBinding({ gateBinding, output, revision, purpose }, { afterPublish = () => {} } = {}) {
  if (!isRevision(revision) || !Object.hasOwn(FROZEN_PURPOSES, purpose)) fail("INPUT_INVALID");
  const accepted = validateGateBinding(gateBinding);
  const requestedOutput = approvalPath(accepted.path, output);
  try { lstatSync(requestedOutput); fail("APPROVAL_OUTPUT_EXISTS"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (accepted.gate.revision !== revision) fail("UNAPPROVED_REVISION");
  if (accepted.gate.purpose !== purpose) fail("APPROVAL_PURPOSE_MISMATCH");

  const bytes = `${JSON.stringify({
    schema: HUMAN_APPROVAL_SCHEMA,
    approved_by: HUMAN_APPROVAL_IDENTITIES.approved_by,
    requested_by: HUMAN_APPROVAL_IDENTITIES.requested_by,
    revision, purpose, approved: true,
  })}\n`;
  validateGateBinding(gateBinding);
  const temporary = createTemporaryApproval(requestedOutput, bytes);
  let created;
  try {
    validateGateBinding(gateBinding);
    try { linkSync(temporary, requestedOutput); } catch (error) {
      if (error?.code === "EEXIST") fail("APPROVAL_OUTPUT_EXISTS");
      throw error;
    }
    created = readNoFollowApprovalOutput(requestedOutput);
    const temporaryIdentity = approvalOutputIdentity(lstatSync(temporary), bytes);
    if (!sameOutputNode(created, temporaryIdentity)) fail("APPROVAL_OUTPUT_INVALID");
    unlinkSync(temporary);
    const published = readNoFollowApprovalOutput(requestedOutput);
    if (!sameOutputNode(created, published)) fail("APPROVAL_OUTPUT_CHANGED");
    created = published;
    afterPublish();
    validateGateBinding(gateBinding);
    if (!sameOutputIdentity(created, readNoFollowApprovalOutput(requestedOutput))) fail("APPROVAL_OUTPUT_CHANGED");
    const approval = assertApprovedRevision(requestedOutput, revision, purpose);
    if (!sameOutputIdentity(created, readNoFollowApprovalOutput(requestedOutput))) fail("APPROVAL_OUTPUT_CHANGED");
    validateGateBinding(gateBinding);
    return approval;
  } catch (error) {
    if (created) removeOnlyCreatedOutput(requestedOutput, created);
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* Best effort. */ }
  }
}

function readHumanApproval(input, outputStream, revision, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      if (error) reject(error); else resolvePromise(value);
    };
    const timeout = setTimeout(() => finish(new Error("HUMAN_APPROVAL_INPUT_TIMEOUT")), timeoutMs);
    lines.once("line", (line) => finish(undefined, line));
    lines.once("close", () => finish(new Error("HUMAN_APPROVAL_INPUT_EOF")));
    outputStream.write(`Approval> type exactly: approve ${revision}\n`);
  });
}

export async function completeInteractiveApproval({
  gateBinding,
  input = process.stdin,
  output,
  outputStream = process.stdout,
  purpose,
  revision,
  timeoutMs = 300_000,
}, hooks = {}) {
  if (!isRevision(revision) || !Object.hasOwn(FROZEN_PURPOSES, purpose)) fail("INPUT_INVALID");
  const accepted = validateGateBinding(gateBinding);
  const requestedOutput = approvalPath(accepted.path, output);
  if (accepted.gate.revision !== revision) fail("UNAPPROVED_REVISION");
  if (accepted.gate.purpose !== purpose) fail("APPROVAL_PURPOSE_MISMATCH");
  try { lstatSync(requestedOutput); fail("APPROVAL_OUTPUT_EXISTS"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const humanInput = await readHumanApproval(input, outputStream, revision, timeoutMs);
  if (humanInput !== `approve ${revision}`) fail("HUMAN_APPROVAL_INPUT_INVALID");
  validateGateBinding(gateBinding);
  return publishApprovalFromBinding(
    { gateBinding, output: requestedOutput, revision, purpose },
    { afterPublish: hooks.afterPublish },
  );
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  process.stderr.write("Approval not written: LIVE_HOLDER_REQUIRED. Use the foreground gate opener.\n");
  process.exitCode = 1;
}

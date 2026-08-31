#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

import {
  HUMAN_APPROVAL_IDENTITIES,
  HUMAN_APPROVAL_SCHEMA,
  assertApprovalGateHandoff,
  assertApprovedRevision,
  readApprovalGateHandoff,
  removeOwnedApprovalGateHandoff,
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
function sameOutputIdentity(left, right) { return sameOutputNode(left, right) && left.ctime_ms === right.ctime_ms && left.mtime_ms === right.mtime_ms; }

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

export function readApprovalGate(path, { fstat = fstatSync, lstat = lstatSync, readFile = readFileSync } = {}) {
  let handoff;
  try { handoff = readApprovalGateHandoff(path, { fstat, lstat, read: readFile }); } catch (error) {
    if (error?.message === "APPROVAL_GATE_ANCESTOR_CHANGED") fail("SYMLINK_PATH_FORBIDDEN");
    if (/^APPROVAL_GATE_(?:HANDOFF_)?(?:BINDING_)?CHANGED/.test(error?.message ?? "")) fail("APPROVAL_GATE_CHANGED");
    fail("APPROVAL_GATE_INVALID");
  }
  const binding = handoff.binding;
  if (binding.file.mode !== 0o600) fail("APPROVAL_GATE_INVALID");
  if (typeof process.getuid === "function" && binding.file.owner !== String(process.getuid())) fail("APPROVAL_GATE_OWNER_INVALID");
  const value = binding.gate;
  if (!sameKeys(value, GATE_KEYS) || value.schema !== GATE_SCHEMA || !isRevision(value.revision)
    || typeof value.purpose !== "string" || typeof value.opened_at !== "string"
    || !Number.isFinite(Date.parse(value.opened_at)) || !Object.hasOwn(FROZEN_PURPOSES, value.purpose)
    || !FROZEN_PURPOSES[value.purpose](value.observed)
    || (value.purpose === "promote-v2" && value.observed.revision === value.revision)) fail("APPROVAL_GATE_INVALID");
  return { path: binding.path, metadata: binding.file, value, binding, handoff };
}

function assertGateUnchanged(accepted) {
  try { assertApprovalGateHandoff(accepted.handoff); } catch { fail("APPROVAL_GATE_CHANGED"); }
}

function parseArgs(argv) {
  const allowed = ["--gate", "--output", "--revision", "--purpose"];
  const values = {};
  if (argv.length !== allowed.length * 2) fail("USAGE");
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key) || typeof value !== "string" || value.startsWith("--") || Object.hasOwn(values, key)) fail("USAGE");
    values[key] = value;
  }
  if (allowed.some((key) => !Object.hasOwn(values, key))) fail("USAGE");
  return { gate: values["--gate"], output: values["--output"], revision: values["--revision"], purpose: values["--purpose"] };
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
        try { closeSync(descriptor); } catch { /* The original write failure remains authoritative. */ }
      }
      try { unlinkSync(temporary); } catch { /* Best effort; never mask the original failure. */ }
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("APPROVAL_TEMPORARY_CREATE_FAILED");
}

function removeOnlyCreatedOutput(path, expected) {
  try {
    if (sameOutputIdentity(readNoFollowApprovalOutput(path), expected)) unlinkSync(path);
  } catch { /* Fail closed: never remove a replacement. */ }
}

export function createApprovalFromGate({ gate, output, revision, purpose }, { afterPublish = () => {} } = {}) {
  if (!isRevision(revision) || !Object.hasOwn(FROZEN_PURPOSES, purpose)) fail("INPUT_INVALID");
  const accepted = readApprovalGate(gate);
  const expectedOutput = accepted.path.slice(0, -GATE_SUFFIX.length);
  const requestedOutput = resolve(output);
  if (!accepted.path.endsWith(GATE_SUFFIX) || requestedOutput !== expectedOutput || dirname(requestedOutput) !== dirname(accepted.path)) fail("APPROVAL_PATH_FORBIDDEN");
  try { lstatSync(requestedOutput); fail("APPROVAL_OUTPUT_EXISTS"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (accepted.value.revision !== revision) fail("UNAPPROVED_REVISION");
  if (accepted.value.purpose !== purpose) fail("APPROVAL_PURPOSE_MISMATCH");

  const bytes = `${JSON.stringify({
    schema: HUMAN_APPROVAL_SCHEMA, approved_by: HUMAN_APPROVAL_IDENTITIES.approved_by, requested_by: HUMAN_APPROVAL_IDENTITIES.requested_by,
    revision, purpose, approved: true,
  })}\n`;
  assertGateUnchanged(accepted);
  const temporary = createTemporaryApproval(requestedOutput, bytes);
  let created;
  try {
    assertGateUnchanged(accepted);
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
    assertGateUnchanged(accepted);
    if (!sameOutputIdentity(created, readNoFollowApprovalOutput(requestedOutput))) fail("APPROVAL_OUTPUT_CHANGED");
    assertApprovedRevision(requestedOutput, revision, purpose);
    if (!sameOutputIdentity(created, readNoFollowApprovalOutput(requestedOutput))) fail("APPROVAL_OUTPUT_CHANGED");
    assertGateUnchanged(accepted);
    removeOwnedApprovalGateHandoff(accepted.handoff.ownership);
    return { revision, purpose };
  } catch (error) {
    if (created) removeOnlyCreatedOutput(requestedOutput, created);
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* Best effort; primary validation failures must remain visible. */ }
  }
}

function main() {
  try {
    const approval = createApprovalFromGate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Approved revision ${approval.revision} for ${approval.purpose}.\n`);
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error?.message) ? error.message : "APPROVAL_OPERATION_FAILED";
    process.stderr.write(`Approval not written: ${code}.\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) main();

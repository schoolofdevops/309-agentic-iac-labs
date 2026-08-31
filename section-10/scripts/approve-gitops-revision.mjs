#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve, sep } from "node:path";

import { HUMAN_APPROVAL_IDENTITIES, HUMAN_APPROVAL_SCHEMA, assertApprovedRevision } from "./run-gitops-lifecycle.mjs";

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

function assertNoSymlinkAncestors(path, { lstat = lstatSync } = {}) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const metadata = lstat(current);
    // macOS exposes its normal temporary area through /var -> /private/var.
    // It is an OS path alias, not a learner-controlled approval boundary.
    const macosTemporaryAlias = current === "/var" && realpathSync(current) === "/private/var";
    if (metadata.isSymbolicLink() && !macosTemporaryAlias) fail("SYMLINK_PATH_FORBIDDEN");
  }
  return absolute;
}

function assertSafeGateMetadata(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) fail("APPROVAL_GATE_INVALID");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) fail("APPROVAL_GATE_OWNER_INVALID");
}

export function readApprovalGate(path, { lstat = lstatSync, readFile = readFileSync } = {}) {
  let absolute;
  let before;
  try {
    absolute = assertNoSymlinkAncestors(path, { lstat });
    before = lstat(absolute);
  } catch (error) {
    if (error?.message === "SYMLINK_PATH_FORBIDDEN") throw error;
    fail("APPROVAL_GATE_INVALID");
  }
  assertSafeGateMetadata(before);
  let value;
  try { value = JSON.parse(readFile(absolute, "utf8")); } catch { fail("APPROVAL_GATE_INVALID"); }
  if (!sameKeys(value, GATE_KEYS) || value.schema !== GATE_SCHEMA || !isRevision(value.revision)
    || typeof value.purpose !== "string" || typeof value.opened_at !== "string"
    || !Number.isFinite(Date.parse(value.opened_at)) || !Object.hasOwn(FROZEN_PURPOSES, value.purpose)
    || !FROZEN_PURPOSES[value.purpose](value.observed)
    || (value.purpose === "promote-v2" && value.observed.revision === value.revision)) fail("APPROVAL_GATE_INVALID");
  let after;
  try { after = lstat(absolute); } catch { fail("APPROVAL_GATE_CHANGED_DURING_READ"); }
  assertSafeGateMetadata(after);
  if (!sameIdentity(before, after)) fail("APPROVAL_GATE_CHANGED_DURING_READ");
  return { path: absolute, metadata: after, value };
}

function assertGateUnchanged(accepted) {
  const current = readApprovalGate(accepted.path);
  if (!sameIdentity(current.metadata, accepted.metadata)
    || JSON.stringify(current.value) !== JSON.stringify(accepted.value)) fail("APPROVAL_GATE_CHANGED");
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
      return temporary;
    } catch (error) {
      if (descriptor != null) closeSync(descriptor);
      try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("APPROVAL_TEMPORARY_CREATE_FAILED");
}

function removeOnlyCreatedOutput(path, expected) {
  try {
    const current = lstatSync(path);
    if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, expected)) unlinkSync(path);
  } catch { /* Fail closed: never remove a replacement. */ }
}

export function createApprovalFromGate({ gate, output, revision, purpose }) {
  if (!isRevision(revision) || !Object.hasOwn(FROZEN_PURPOSES, purpose)) fail("INPUT_INVALID");
  const accepted = readApprovalGate(gate);
  const expectedOutput = accepted.path.slice(0, -GATE_SUFFIX.length);
  const requestedOutput = resolve(output);
  if (!accepted.path.endsWith(GATE_SUFFIX) || requestedOutput !== expectedOutput || dirname(requestedOutput) !== dirname(accepted.path)) fail("APPROVAL_PATH_FORBIDDEN");
  assertNoSymlinkAncestors(dirname(requestedOutput));
  try { lstatSync(requestedOutput); fail("APPROVAL_OUTPUT_EXISTS"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (accepted.value.revision !== revision) fail("UNAPPROVED_REVISION");
  if (accepted.value.purpose !== purpose) fail("APPROVAL_PURPOSE_MISMATCH");

  const bytes = `${JSON.stringify({
    schema: HUMAN_APPROVAL_SCHEMA, approved_by: HUMAN_APPROVAL_IDENTITIES.approved_by, requested_by: HUMAN_APPROVAL_IDENTITIES.requested_by,
    revision, purpose, approved: true,
  })}\n`;
  const temporary = createTemporaryApproval(requestedOutput, bytes);
  let created;
  try {
    assertGateUnchanged(accepted);
    linkSync(temporary, requestedOutput);
    created = lstatSync(requestedOutput);
    if (!created.isFile() || created.isSymbolicLink() || (created.mode & 0o777) !== 0o600 || !sameIdentity(created, lstatSync(temporary))) fail("APPROVAL_OUTPUT_INVALID");
    assertGateUnchanged(accepted);
    unlinkSync(temporary);
    assertApprovedRevision(requestedOutput, revision, purpose);
    return { revision, purpose };
  } catch (error) {
    if (created) removeOnlyCreatedOutput(requestedOutput, created);
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
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

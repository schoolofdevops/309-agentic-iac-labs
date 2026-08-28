#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(1);
}

const requested = process.argv[2];
if (!requested) refuse("provide one evidence directory");
const logicalTemporaryRoot = resolve(tmpdir());
const canonicalTemporaryRoot = realpathSync(logicalTemporaryRoot);
const logical = resolve(requested);
const absolute = logical.startsWith(`${logicalTemporaryRoot}${sep}`)
  ? `${canonicalTemporaryRoot}${logical.slice(logicalTemporaryRoot.length)}`
  : logical;
if (dirname(absolute) !== canonicalTemporaryRoot || !basename(absolute).startsWith("agentic-iac-s10-")) refuse("evidence is not a direct course-owned temporary child");

let current = sep;
for (const component of absolute.split(sep).filter(Boolean)) {
  current = join(current, component);
  if (!existsSync(current) || lstatSync(current).isSymbolicLink()) refuse("evidence path has a missing or symlink component");
}

let marker;
try {
  marker = readFileSync(join(absolute, ".agentic-iac-s10-evidence-root"), "utf8").trim();
} catch {
  refuse("trusted evidence marker is missing");
}
if (marker !== "section-10-task-3") refuse("trusted evidence marker is invalid");
rmSync(absolute, { recursive: true });
process.stdout.write(`Removed course evidence: ${absolute}\n`);

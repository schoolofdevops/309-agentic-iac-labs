#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(1);
}

const requested = process.argv[2];
if (!requested) refuse("provide one evidence directory");

const logicalTemporaryRoot = resolve(tmpdir());
const temporaryRoot = realpathSync(logicalTemporaryRoot);
const absolute = resolve(requested);
if (dirname(absolute) !== logicalTemporaryRoot && dirname(absolute) !== temporaryRoot) refuse("evidence is outside the operating-system temporary directory");
if (!basename(absolute).startsWith("agentic-iac-s10-")) refuse("evidence name lacks the course prefix");
if (lstatSync(absolute).isSymbolicLink() || realpathSync(dirname(absolute)) !== temporaryRoot) refuse("evidence path is not a direct, regular temporary child");

let marker;
try {
  marker = JSON.parse(readFileSync(`${absolute}/.agentic-iac-s10-evidence.json`, "utf8"));
} catch {
  refuse("the trusted evidence marker is missing or invalid");
}
if (marker.task_id !== "section-10-task-3" || marker.path !== realpathSync(absolute)) refuse("the evidence marker does not bind this directory");

rmSync(absolute, { recursive: true });
process.stdout.write(`Removed course evidence: ${absolute}\n`);

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SAFE_WORKFLOW_SHA256 = "337c1561ebebff73c35180216bdccae24e27d7ab530f269a3c55d05141a66bd2";

class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reject(code, message) {
  throw new ContractError(code, message);
}

function getArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) reject("USAGE", `missing ${name}`);
  return process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function checkWorkflowContract(workflow) {
  const actual = sha256(workflow);
  if (actual !== SAFE_WORKFLOW_SHA256) {
    reject("WORKFLOW_INVARIANT", `expected ${SAFE_WORKFLOW_SHA256}, got ${actual}`);
  }
  return { status: "READY_FOR_HUMAN_REVIEW", workflow_sha256: actual };
}

function main() {
  try {
    const workflowPath = getArgument("--workflow");
    const result = checkWorkflowContract(readFileSync(workflowPath));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "WORKFLOW_READ_ERROR";
    process.stderr.write(`REJECTED ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

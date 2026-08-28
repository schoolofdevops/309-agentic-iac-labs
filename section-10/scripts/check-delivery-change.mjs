#!/usr/bin/env node

import { readFileSync } from "node:fs";

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

function runBlocks(workflow) {
  const lines = workflow.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const block = [match[2]];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextIndent = next.match(/^\s*/)[0].length;
      if (next.trim() && nextIndent <= indent) break;
      block.push(next);
      index += 1;
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

export function checkWorkflowContract(workflow) {
  if (/^\s*pull_request_target\s*:/m.test(workflow)) {
    reject("UNSAFE_EVENT", "pull_request_target can execute privileged base-branch code");
  }
  if (!/^\s{2}pull_request\s*:/m.test(workflow)) {
    reject("PULL_REQUEST_REQUIRED", "the guarded plan must run on pull_request");
  }
  if (/permissions\s*:\s*write-all\b/i.test(workflow) || /^\s+[\w-]+\s*:\s*write\s*$/im.test(workflow)) {
    reject("WRITE_PERMISSION", "workflow permissions must remain read-only");
  }
  if (!/^permissions:\s*\n(?:\s+[^\n]+\n)*?\s{2}contents:\s*read\s*$/m.test(workflow)) {
    reject("READ_PERMISSION_REQUIRED", "permissions must explicitly grant contents read only");
  }
  if (/\bsecrets\b\s*[:.]/i.test(workflow)) {
    reject("SECRET_ACCESS", "fork-safe plan workflows cannot access secrets");
  }
  if (/\b(?:apply|destroy)\b/i.test(workflow)) {
    reject("APPLY_DESTROY_FORBIDDEN", "plan-only workflow contains a deployment command token");
  }
  for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*$/gm)) {
    if (!/@[0-9a-f]{40}$/.test(match[1])) {
      reject("UNPINNED_ACTION", `action is not pinned to a full commit: ${match[1]}`);
    }
  }
  if (!/^concurrency:\s*$/m.test(workflow) || !/^\s{2}cancel-in-progress:\s*true\s*$/m.test(workflow)) {
    reject("CONCURRENCY_REQUIRED", "workflow must cancel superseded plan runs");
  }
  if (!/uses:\s*actions\/upload-artifact@[0-9a-f]{40}/.test(workflow)) {
    reject("ARTIFACT_UPLOAD_REQUIRED", "bounded plan evidence upload is required");
  }
  const retention = workflow.match(/^\s+retention-days:\s*(\d+)\s*$/m);
  if (!retention || Number(retention[1]) < 1 || Number(retention[1]) > 30) {
    reject("ARTIFACT_RETENTION", "artifact retention must be between 1 and 30 days");
  }
  if (!/^\s+if-no-files-found:\s*error\s*$/m.test(workflow)) {
    reject("ARTIFACT_BOUNDS", "missing evidence must fail the upload step");
  }
  if (runBlocks(workflow).some((block) => block.includes("${{"))) {
    reject("SHELL_INTERPOLATION", "GitHub expressions cannot be interpolated into shell commands");
  }
  return { status: "READY_FOR_HUMAN_REVIEW" };
}

function main() {
  try {
    const workflowPath = getArgument("--workflow");
    const result = checkWorkflowContract(readFileSync(workflowPath, "utf8"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "WORKFLOW_READ_ERROR";
    process.stderr.write(`REJECTED ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();


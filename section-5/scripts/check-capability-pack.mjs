#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const starterRoot = resolve(process.argv[2] ?? 'section-5/starter');
const incomingRoot = resolve(process.argv[3] ?? 'section-5/incoming');

function read(path) {
  if (!existsSync(path)) throw new Error(`missing artifact: ${path}`);
  return readFileSync(path, 'utf8');
}

function parseJson(path) {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    throw new Error(`invalid JSON: ${path}: ${error.message}`);
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

try {
  const incomingManifest = parseJson(`${incomingRoot}/manifest.json`);
  if (incomingManifest.schema !== 'course.agentic-iac.immutable-inputs/v1' || incomingManifest.mutable !== false) {
    throw new Error('invalid immutable-input manifest');
  }
  for (const entry of incomingManifest.files ?? []) {
    if (sha256(read(`${incomingRoot}/${entry.path}`)) !== entry.sha256) {
      throw new Error(`checksum mismatch: ${entry.path}`);
    }
  }

  const serverRequest = parseJson(`${incomingRoot}/server-admission-request.json`);
  if (
    serverRequest.schema !== 'course.agentic-iac.capability-admission/v1' ||
    serverRequest.manifestType !== 'course-control-artifact' ||
    serverRequest.isMcpStandardManifest !== false
  ) {
    throw new Error('invalid course admission schema boundary');
  }

  const commandContract = parseJson(`${starterRoot}/runner/command-contract.json`);
  if (
    commandContract.shell !== false ||
    commandContract.workingDirectory !== 'section-5/fixture' ||
    commandContract.timeoutMs !== 30000 ||
    JSON.stringify(commandContract.commands) !== JSON.stringify([
      ['fmt', '-check', '-diff', 'main.tf'],
      ['init', '-backend=false', '-input=false', '-no-color'],
      ['validate', '-no-color'],
    ]) ||
    commandContract.environment?.CHECKPOINT_DISABLE !== '1' ||
    commandContract.environment?.TF_IN_AUTOMATION !== '1'
  ) {
    throw new Error('invalid fixed CLI command contract');
  }

  const fixture = read(resolve(starterRoot, '../fixture/main.tf'));
  if (/\b(provider|backend)\s+"/i.test(fixture) || /\b(plan|apply|destroy|state)\b/i.test(fixture)) {
    throw new Error('invalid provider-free fixture boundary');
  }

  const probe = spawnSync(process.execPath, [`${starterRoot}/mcp/probe.mjs`], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1' },
  });
  if (probe.status !== 0 || !/^MCP resource probe: PASS$/m.test(probe.stdout) || probe.stderr) {
    throw new Error(`MCP contract failed: ${probe.stdout}${probe.stderr}`);
  }

  const skill = read(`${starterRoot}/skills/terraform-review/SKILL.md`);
  const decision = parseJson(`${starterRoot}/admission/decision.json`);
  const decisions = new Map((decision.decisions ?? []).map((entry) => [entry.capability, entry]));
  const problems = [];

  if (
    !/^## Procedure$/m.test(skill) ||
    !/^## Stop conditions$/m.test(skill) ||
    !/references\/command-contract\.md/.test(skill) ||
    !/scripts\/review-iac\.mjs/.test(skill)
  ) {
    problems.push(
      'skills/terraform-review/SKILL.md [skill.procedure]: Complete the reviewed procedure, command reference, deterministic runner, tests, owner, version, compatibility, and stop conditions before admission.',
    );
  }

  if (decisions.get('incoming-skill:repository-operator')?.decision !== 'reject') {
    problems.push(
      'admission/decision.json [incoming-skill.decision]: Reject the incoming Skill; it requests broad writes, shell execution, network, credentials, and apply authority.',
    );
  }

  if (decisions.get('incoming-server:anywhere-mcp')?.decision !== 'reject') {
    problems.push(
      'admission/decision.json [incoming-server.decision]: Reject the incoming server request; do not admit a capability because it labels itself read-only.',
    );
  }

  const requiredServerReasons = ['unpinned-startup', 'broad-authority', 'mutating-tool-mislabeled-read-only'];
  if (requiredServerReasons.some((reason) => !(decision.rejectedServerReasons ?? []).includes(reason))) {
    problems.push(
      'admission/decision.json [incoming-server.reasons]: Record the unpinned startup, broad filesystem/network/secret authority, and mutating tools mislabeled read-only.',
    );
  }

  const enforcement = decision.enforcement ?? {};
  if (
    enforcement.skillAllowedToolsIsPermissionBoundary !== false ||
    enforcement.mcpAnnotationsArePermissionBoundary !== false ||
    enforcement.serverIdentityProvesTrust !== false ||
    decision.humanApprovalRequired !== true
  ) {
    problems.push(
      'admission/decision.json [metadata.enforcement]: Treat Skill metadata, MCP annotations, and server identity as review inputs; enforce authority in the runner, operating system, and human approval boundary.',
    );
  }

  if (problems.length === 0) {
    for (const relativePath of [
      'skills/terraform-review/references/command-contract.md',
      'skills/terraform-review/scripts/review-iac.mjs',
      'skills/terraform-review/tests/review-iac.test.mjs',
      'admission/trust.json',
    ]) {
      if (!existsSync(`${starterRoot}/${relativePath}`)) {
        problems.push(`${relativePath} [completion.artifact]: Add the bounded candidate artifact.`);
      }
    }
  }

  if (problems.length > 0) {
    process.stdout.write(`Capability pack: NEEDS WORK (${problems.length} capability problems found)\n`);
    for (const problem of problems) process.stdout.write(`- ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Capability pack: PASS (0 capability problems found)\n');
    process.stdout.write('CLI, Skill, MCP resource, admission, and enforcement boundaries are valid.\n');
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}

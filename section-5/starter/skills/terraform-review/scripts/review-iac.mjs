#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER_VERSION = '1.0.0';
const scriptPath = fileURLToPath(import.meta.url);
const starterRoot = resolve(dirname(scriptPath), '../../..');
const sectionRoot = resolve(starterRoot, '..');
const contractPath = resolve(starterRoot, 'runner/command-contract.json');
const sourcePath = resolve(sectionRoot, 'fixture/main.tf');
const evidenceRoot = resolve(starterRoot, 'evidence');
const expectedCommands = [
  ['fmt', '-check', '-diff', 'main.tf'],
  ['init', '-backend=false', '-input=false', '-no-color'],
  ['validate', '-no-color'],
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function redact(value) {
  return String(value ?? '')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:TF_VAR_[A-Za-z0-9_]+|token|password|secret)["']?\s*[=:]\s*)["']?[^"'\s,}]+["']?/gi, '$1"[REDACTED]"');
}

function parseArguments(argv) {
  let engine;
  let evidenceName;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${name ?? 'argument'}`);
    if (name === '--engine') engine = value;
    else if (name === '--evidence') evidenceName = value;
    else throw new Error(`unknown argument: ${name}`);
  }
  if (!['terraform', 'tofu'].includes(engine)) throw new Error('engine must be terraform or tofu');
  if (
    !evidenceName ||
    evidenceName.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(evidenceName) ||
    evidenceName.includes('..')
  ) {
    throw new Error('evidence must be a JSON file name such as terraform-review.json; paths are not allowed');
  }
  return { engine, evidenceName };
}

function readContract() {
  const bytes = readFileSync(contractPath);
  const contract = JSON.parse(bytes.toString('utf8'));
  if (
    contract.shell !== false ||
    contract.timeoutMs !== 30000 ||
    contract.workingDirectory !== 'section-5/fixture' ||
    JSON.stringify(contract.allowedExecutables) !== JSON.stringify(['terraform', 'tofu']) ||
    JSON.stringify(contract.commands) !== JSON.stringify(expectedCommands) ||
    JSON.stringify(contract.forbiddenOperations) !== JSON.stringify(['plan', 'apply', 'destroy', 'state'])
  ) {
    throw new Error('review command contract is not the approved fixed contract');
  }
  return { contract, bytes };
}

function commandEnvironment(workRoot) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CHECKPOINT_DISABLE: '1',
    TF_IN_AUTOMATION: '1',
    TF_DATA_DIR: resolve(workRoot, '.terraform-data'),
  };
}

function run(engine, argv, cwd, timeoutMs, environment) {
  const started = performance.now();
  const result = spawnSync(engine, argv, {
    cwd,
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return {
    executable: engine,
    argv,
    workingDirectory: 'isolated temporary copy of section-5/fixture',
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: redact(result.stdout),
    stderr: redact(result.stderr || result.error?.message || ''),
  };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  let workRoot;
  try {
    const { contract, bytes: contractBytes } = readContract();
    const inputBytes = readFileSync(sourcePath);
    workRoot = mkdtempSync(resolve(tmpdir(), 'agentic-iac-review-'));
    copyFileSync(sourcePath, resolve(workRoot, 'main.tf'));
    const environment = commandEnvironment(workRoot);
    const version = run(options.engine, ['version'], workRoot, contract.timeoutMs, environment);
    const engineVersion = version.stdout.split('\n')[0].trim();
    if (version.exitCode !== 0 || version.timedOut || !engineVersion) {
      throw new Error(`could not read ${options.engine} version: ${version.stderr || 'unknown error'}`);
    }

    const startedAt = new Date().toISOString();
    const commands = [];
    for (const argv of contract.commands) {
      const result = run(options.engine, argv, workRoot, contract.timeoutMs, environment);
      commands.push(result);
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    const passed = commands.length === contract.commands.length && commands.every((entry) => entry.exitCode === 0 && !entry.timedOut);
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    const evidenceDirectory = lstatSync(evidenceRoot);
    if (!evidenceDirectory.isDirectory() || evidenceDirectory.isSymbolicLink()) {
      throw new Error('the reviewed evidence directory is not a real directory');
    }
    const evidencePath = resolve(evidenceRoot, options.evidenceName);
    const evidenceFile = `section-5/starter/evidence/${options.evidenceName}`;
    const evidence = {
      schema: 'course.agentic-iac.review-evidence/v1',
      runnerVersion: RUNNER_VERSION,
      startedAt,
      engine: options.engine,
      engineVersion,
      sourceWorkingDirectory: contract.workingDirectory,
      executionWorkingDirectory: 'isolated-temporary-copy',
      evidenceFile,
      shell: false,
      timeoutMs: contract.timeoutMs,
      environmentKeys: Object.keys(environment).sort(),
      inputSha256: sha256(inputBytes),
      contractSha256: sha256(contractBytes),
      commands,
      passed,
    };
    const descriptor = openSync(
      evidencePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }
    process.stdout.write(`IaC review: ${passed ? 'PASS' : 'FAIL'} (${options.engine})\n`);
    process.stdout.write(`Evidence: ${evidenceFile}\n`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${redact(error.message)}\n`);
    process.exitCode = 2;
  } finally {
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
  }
}

main();

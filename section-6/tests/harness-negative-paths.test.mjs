import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {redactText, runCommand} from '../starter/harness/lib/core.mjs';

const section = path.resolve(import.meta.dirname, '..');

function runNode(args, environment = {}) {
  return spawnSync(process.execPath, args, {
    cwd: section,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...environment,
    },
  });
}

test('rejects an unsupported engine before running a command', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'm6-invalid-engine-'));
  try {
    const result = runNode([
      'starter/harness/run-workflow.mjs', '--engine', 'bash', '--output', output,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /engine must be terraform or tofu/);
  } finally {
    rmSync(output, {recursive: true, force: true});
  }
});

test('rejects an operation path that escapes the isolated workspace', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'm6-path-escape-'));
  try {
    const result = runNode([
      'starter/harness/run-workflow.mjs',
      '--engine', 'terraform',
      '--plan', 'tests/malicious-plan.json',
      '--output', output,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /operation path escapes its allowed root/);
  } finally {
    rmSync(output, {recursive: true, force: true});
  }
});

test('rejects a non-empty output directory', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'm6-nonempty-'));
  try {
    writeFileSync(path.join(output, 'keep.txt'), 'preserve me\n');
    const result = runNode([
      'starter/harness/run-workflow.mjs', '--engine', 'terraform', '--output', output,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /output must be a new or empty directory/);
    assert.equal(readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'preserve me\n');
  } finally {
    rmSync(output, {recursive: true, force: true});
  }
});

test('redacts common secret forms before evidence is stored', () => {
  const result = redactText('token=abc password:xyz Bearer top-secret safe=value');
  assert.equal(result.redactions, 3);
  assert.equal(result.text, 'token=[REDACTED] password=[REDACTED] Bearer [REDACTED] safe=value');
});

test('classifies a fixed command timeout', () => {
  const result = runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    section,
    10,
  );
  assert.equal(result.timed_out, true);
  assert.notEqual(result.exit_code, 0);
});

test('OpenTofu produces the same weak-green and complete-rejection boundary', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'm6-tofu-'));
  try {
    const workflow = runNode([
      'starter/harness/run-workflow.mjs', '--engine', 'tofu', '--output', output,
    ]);
    assert.equal(workflow.status, 0, workflow.stderr || workflow.stdout);
    const weak = runNode([
      'starter/harness/evaluate-run.mjs',
      '--run', output,
      '--suite', 'starter/evals/suite.json',
    ]);
    assert.equal(weak.status, 0, weak.stderr || weak.stdout);
    const complete = runNode([
      'starter/harness/evaluate-run.mjs',
      '--run', output,
      '--suite', 'tests/complete-suite.json',
    ]);
    assert.equal(complete.status, 1, complete.stderr || complete.stdout);
    assert.match(complete.stdout, /safety\.scope/);
    assert.match(complete.stdout, /budget\.commands/);
  } finally {
    rmSync(output, {recursive: true, force: true});
  }
});

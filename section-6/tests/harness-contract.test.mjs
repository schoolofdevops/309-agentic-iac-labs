import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const section = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(path.join(section, relativePath), 'utf8');
}

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: section,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
  });
}

test('freezes one provider-free and human-readable harness task', () => {
  const request = read('request.md');
  const taskContract = read('task.md');
  const fixture = read('fixture/main.tf');

  assert.match(request, /functional, safety, regression, and budget/i);
  assert.match(request, /without a model, API key, cloud account/i);
  assert.match(taskContract, /Allowed learner edits/);
  assert.match(taskContract, /Do not run plan, apply, destroy, state/i);
  assert.doesNotMatch(fixture, /\bprovider\s+"/);
  assert.match(fixture, /default\s+=\s+"course-jobs"/);
  assert.match(fixture, /nullable\s+=\s+true/);
});

test('keeps the weak starter visibly unsafe and expensive', () => {
  const plan = JSON.parse(read('starter/workflow/plan.json'));
  const suite = JSON.parse(read('starter/evals/suite.json'));

  assert.deepEqual(suite.enabled_gates, ['functional']);
  assert.equal(plan.validation_repeats, 4);
  assert.equal(plan.retry_limit, 2);
  assert.ok(plan.context.includes('context/noisy-reference.md'));
  assert.ok(plan.operations.some((operation) => operation.path !== 'main.tf'));
});

test('a weak green check is rejected by the complete author suite', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'm6-contract-'));
  try {
    const workflow = runNode([
      'starter/harness/run-workflow.mjs',
      '--engine', 'terraform',
      '--output', output,
    ]);
    assert.equal(workflow.status, 0, workflow.stderr || workflow.stdout);

    const weak = runNode([
      'starter/harness/evaluate-run.mjs',
      '--run', output,
      '--suite', 'starter/evals/suite.json',
    ]);
    assert.equal(weak.status, 0, weak.stderr || weak.stdout);
    assert.match(weak.stdout, /Run evaluation: PASS \(1\/1 enabled gates passed\)/);

    const complete = runNode([
      'starter/harness/evaluate-run.mjs',
      '--run', output,
      '--suite', 'tests/complete-suite.json',
    ]);
    assert.equal(complete.status, 1, complete.stderr || complete.stdout);
    assert.match(complete.stdout, /Run evaluation: REJECTED/);
    assert.match(complete.stdout, /safety\.scope/);
    assert.match(complete.stdout, /budget\.context/);
    assert.match(complete.stdout, /budget\.commands/);
  } finally {
    rmSync(output, {recursive: true, force: true});
  }
});

test('publishes one author check that exposes the weak starter findings', () => {
  const result = runNode(['scripts/check-harness.mjs', 'terraform']);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Workflow run: FUNCTIONAL PASS/);
  assert.match(result.stdout, /Run evaluation: REJECTED/);
  assert.match(result.stdout, /safety\.scope/);
  assert.match(result.stdout, /budget\.context/);
});

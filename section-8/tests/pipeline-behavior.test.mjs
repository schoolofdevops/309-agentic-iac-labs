import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const section = resolve(import.meta.dirname, '..');
const runner = resolve(section, 'scripts/run-evidence-pipeline.mjs');

test('starter is rejected even though format, validation, plan, and faulty policy are green', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-8-test-'));
  const output = join(parent, 'agentic-iac-section-8-starter');
  try {
    const result = spawnSync(process.execPath, [runner, 'terraform', section, output], {encoding: 'utf8'});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
    assert.equal(report.decision, 'REJECTED');
    assert.equal(report.gates.format.status, 'PASS');
    assert.equal(report.gates.validation.status, 'PASS');
    assert.equal(report.gates.plan.status, 'PASS');
    assert.equal(report.observations.conftest_exit, 0);
    for (const gate of ['contract', 'lint', 'security', 'policy', 'cost']) assert.equal(report.gates[gate].status, 'FAIL');
    for (const gate of ['redaction', 'agent_safety']) assert.equal(report.gates[gate].status, 'PASS');
    assert.equal(report.observations.plan_resource_count, 6);
    assert.equal(report.observations.secret_values_stored, 0);
    assert.ok(report.observations.redactions >= 1);
    assert.match(report.source_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.plan_sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('runner rejects unsupported engine before creating output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-8-test-'));
  const output = join(parent, 'agentic-iac-section-8-invalid');
  try {
    const result = spawnSync(process.execPath, [runner, 'invalid', section, output], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(join(output, 'evidence-report.json')));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('runner rejects a pre-existing output directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-8-test-'));
  const output = join(parent, 'agentic-iac-section-8-existing');
  await import('node:fs/promises').then(({mkdir}) => mkdir(output));
  try {
    const result = spawnSync(process.execPath, [runner, 'terraform', section, output], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/i);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

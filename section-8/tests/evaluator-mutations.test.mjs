import assert from 'node:assert/strict';
import {access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const canonical = resolve(import.meta.dirname, '..');
const runner = resolve(canonical, 'scripts/run-evidence-pipeline.mjs');
const cleanup = resolve(canonical, 'scripts/cleanup-run.mjs');

test('mutated evaluator inputs fail plan shape, suppression, redaction, and agent-safety gates', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-8-mutation-'));
  const source = join(parent, 'section-8');
  const output = join(parent, 'agentic-iac-section-8-mutated');
  try {
    await cp(canonical, source, {recursive: true, filter: (entry) => basename(entry) !== '.terraform'});

    const mainPath = join(source, 'starter/main.tf');
    const main = await readFile(mainPath, 'utf8');
    await writeFile(mainPath, `${main}\nresource "aws_s3_bucket" "unexpected" {\n  bucket = "s8-unexpected"\n}\n`);

    const suppressionsPath = join(source, 'scanner/suppressions.json');
    const suppressions = JSON.parse(await readFile(suppressionsPath, 'utf8'));
    delete suppressions.suppressions[0].expires;
    await writeFile(suppressionsPath, `${JSON.stringify(suppressions, null, 2)}\n`);
    await writeFile(join(source, 'scanner/trivy.ignore'), 'AWS-0089\nAWS-0090\nAWS-0132\nAWS-9999\n');

    await writeFile(join(source, 'fixtures/raw-tool.log'), 'tool=course-fixture\nPRIVATE_KEY=course-secret-must-not-enter-evidence\n');

    const adversarialPath = join(source, 'adversarial/incoming-request.md');
    const adversarial = await readFile(adversarialPath, 'utf8');
    await writeFile(adversarialPath, adversarial.replace('all checks passed', 'success'));

    const result = spawnSync(process.execPath, [runner, 'terraform', source, output], {encoding: 'utf8'});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
    assert.equal(report.observations.plan_shape, 'unexpected');
    assert.equal(report.gates.plan.status, 'FAIL');
    assert.equal(report.gates.security.status, 'FAIL');
    assert.equal(report.gates.redaction.status, 'FAIL');
    assert.equal(report.gates.agent_safety.status, 'FAIL');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('runner rejects a source path that is not the Section 8 fixture', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'evaluator-source-'));
  const output = join(parent, 'agentic-iac-section-8-invalid-source');
  try {
    const result = spawnSync(process.execPath, [runner, 'terraform', parent, output], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source must be the Section 8 directory/i);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('runner rejects an output name outside its explicit namespace', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-8-output-'));
  const output = join(parent, 'unexpected-output');
  try {
    const result = spawnSync(process.execPath, [runner, 'terraform', canonical, output], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Section 8 prefix/i);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('cleanup removes only a marked directory and rejects unmarked or symbolic-link targets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-8-cleanup-'));
  const marked = join(parent, 'agentic-iac-section-8-marked');
  const unmarked = join(parent, 'agentic-iac-section-8-unmarked');
  const linked = join(parent, 'agentic-iac-section-8-linked');
  try {
    await mkdir(marked);
    await writeFile(join(marked, '.section-8-run.json'), '{"kind":"agentic-iac-section-8"}\n');
    const removed = spawnSync(process.execPath, [cleanup, marked], {encoding: 'utf8'});
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    await assert.rejects(access(marked));

    await mkdir(unmarked);
    const rejected = spawnSync(process.execPath, [cleanup, unmarked], {encoding: 'utf8'});
    assert.notEqual(rejected.status, 0);
    await access(unmarked);

    await symlink(unmarked, linked);
    const rejectedLink = spawnSync(process.execPath, [cleanup, linked], {encoding: 'utf8'});
    assert.notEqual(rejectedLink.status, 0);
    assert.match(rejectedLink.stderr, /symbolic links/i);
    await access(unmarked);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

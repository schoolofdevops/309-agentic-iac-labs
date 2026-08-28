import assert from 'node:assert/strict';
import {access, chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const section = resolve(import.meta.dirname, '..');
const runner = resolve(section, 'scripts/check-package.mjs');
const cleanup = resolve(section, 'scripts/cleanup-kind.mjs');

async function temporarySection(prefix) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const source = join(parent, 'section-9');
  await cp(section, source, {recursive: true});
  return {parent, source};
}

function runEvaluator(script, source, output, options = {}) {
  return spawnSync(process.execPath, [script, source, output], {
    encoding: 'utf8',
    timeout: 180_000,
    ...options,
  });
}

test('evaluator rejects path escape and a symbolic-link source', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-9-paths-'));
  const linked = join(parent, 'section-9');
  const output = join(parent, 'agentic-iac-section-9-path-test');
  try {
    const escaped = runEvaluator(runner, resolve(section, '..'), output);
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /source must be a Section 9 directory/i);

    await symlink(section, linked);
    const linkedResult = runEvaluator(runner, linked, output);
    assert.notEqual(linkedResult.status, 0);
    assert.match(linkedResult.stderr, /symbolic links/i);
    await assert.rejects(access(output));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('evaluator rejects unsafe output, missing tools, and changed evaluated scope', async () => {
  const {parent, source} = await temporarySection('section-9-rejections-');
  const unsafeOutput = resolve(section, 'agentic-iac-section-9-unsafe-output');
  const safeOutput = join(parent, 'agentic-iac-section-9-safe-output');
  try {
    const unsafe = runEvaluator(runner, source, unsafeOutput);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /temporary directory/i);
    await assert.rejects(access(unsafeOutput));

    const emptyPath = join(parent, 'empty-path');
    await mkdir(emptyPath);
    const missingTool = runEvaluator(runner, source, safeOutput, {env: {...process.env, PATH: emptyPath}});
    assert.notEqual(missingTool.status, 0);
    assert.match(missingTool.stderr, /required tool .* is unavailable/i);
    await assert.rejects(access(safeOutput));

    await writeFile(join(source, 'chart/unexpected.yaml'), 'unexpected: true\n');
    const changedScope = runEvaluator(runner, source, safeOutput);
    assert.notEqual(changedScope.status, 0);
    assert.match(changedScope.stderr, /evaluated source scope changed/i);
    await assert.rejects(access(safeOutput));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('evaluator rejects nested symlinks, pre-existing output, and an empty render', async () => {
  const {parent, source} = await temporarySection('section-9-inputs-');
  const output = join(parent, 'agentic-iac-section-9-input-test');
  try {
    const target = join(parent, 'outside-values.yaml');
    await writeFile(target, 'outside: true\n');
    await rm(join(source, 'chart/values.yaml'));
    await symlink(target, join(source, 'chart/values.yaml'));
    const linked = runEvaluator(runner, source, output);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /symbolic links/i);

    await rm(source, {recursive: true, force: true});
    await cp(section, source, {recursive: true});
    await mkdir(output);
    const existing = runEvaluator(runner, source, output);
    assert.notEqual(existing.status, 0);
    assert.match(existing.stderr, /already exists/i);

    await rm(output, {recursive: true, force: true});
    const template = join(source, 'chart/templates/deployment.yaml');
    const original = await readFile(template, 'utf8');
    await writeFile(template, '{{- if false }}\n' + original + '\n{{- end }}\n');
    for (const file of ['configmap.yaml', 'networkpolicy.yaml', 'service.yaml', 'serviceaccount.yaml']) {
      await writeFile(join(source, 'chart/templates', file), '{{- if false }}{{- end }}\n');
    }
    const empty = runEvaluator(runner, source, output);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr + empty.stdout, /empty render/i);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('evaluator rejects a change outside the three learner-owned chart files', async () => {
  const {parent, source} = await temporarySection('section-9-read-only-');
  const output = join(parent, 'agentic-iac-section-9-read-only-change');
  try {
    const main = join(source, 'app/main.go');
    await writeFile(main, `${await readFile(main, 'utf8')}\n// unapproved learner edit\n`);
    const result = runEvaluator(runner, source, output);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
    assert.equal(report.gates.allowed_source_scope.status, 'FAIL');
    assert.ok(report.primary_findings.some(({id}) => id === 'changed-read-only-source'));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('required evaluator mutations are killed', async (t) => {
  const original = await readFile(runner, 'utf8');
  const mutations = [
    ['removed limit check', 'const CHECK_RESOURCE_LIMITS = true;', 'const CHECK_RESOURCE_LIMITS = false;'],
    ['weakened secret detection', 'const CHECK_SECRET_MATERIAL = true;', 'const CHECK_SECRET_MATERIAL = false;'],
    ['skipped schema', 'const RUN_SCHEMA_CHECKS = true;', 'const RUN_SCHEMA_CHECKS = false;'],
    ['misleading green summary', 'const summaryDecision = report.decision;', "const summaryDecision = 'READY_FOR_HUMAN_REVIEW';"],
  ];

  for (const [name, needle, replacement] of mutations) {
    await t.test(name, async () => {
      assert.ok(original.includes(needle), `mutation hook missing: ${needle}`);
      const {parent, source} = await temporarySection('section-9-mutant-');
      const mutant = join(parent, 'check-package-mutant.mjs');
      const output = join(parent, `agentic-iac-section-9-${name.replaceAll(' ', '-')}`);
      try {
        await writeFile(mutant, original.replace(needle, replacement));
        const result = runEvaluator(mutant, source, output);
        const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
        const acceptable = result.status === 1
          && result.stdout.includes('Section 9 package: REJECTED')
          && !result.stdout.includes('READY_FOR_HUMAN_REVIEW')
          && report.decision === 'REJECTED'
          && JSON.stringify(report.primary_findings.map(({id}) => id)) === JSON.stringify([
            'committed-backend-token-material',
            'missing-worker-resource-limits',
          ])
          && report.gates.schema.status === 'FAIL'
          && report.commands.some(({id}) => id === 'schema-worker-limits');
        assert.equal(acceptable, false, `${name} survived the evaluator contract`);
      } finally {
        await rm(parent, {recursive: true, force: true});
      }
    });
  }
});

test('cleanup invokes only the marked exact Kind cluster and rejects unsafe markers', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-9-cleanup-'));
  const bin = join(parent, 'bin');
  const run = join(parent, 'agentic-iac-section-9-kind-run');
  const log = join(parent, 'kind-argv.txt');
  const marker = join(run, '.section-9-kind-run.json');
  try {
    await mkdir(bin);
    await mkdir(run);
    const fakeKind = join(bin, 'kind');
    await writeFile(fakeKind, '#!/bin/sh\nprintf "%s\\n" "$*" > "$S9_FAKE_KIND_LOG"\n');
    await chmod(fakeKind, 0o755);
    await writeFile(marker, JSON.stringify({
      schema: 'agentic-iac-section-9-kind-run/v1',
      cluster: 'agentic-iac-s9',
      namespace: 'inference',
      release: 'inference-platform',
      cleanup_allowed: true,
    }) + '\n');

    const cleaned = spawnSync(process.execPath, [cleanup, marker], {
      encoding: 'utf8',
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, S9_FAKE_KIND_LOG: log},
    });
    assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
    assert.equal((await readFile(log, 'utf8')).trim(), 'delete cluster --name agentic-iac-s9');
    const updated = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(updated.cleanup_status, 'COMPLETE');
    assert.match(updated.cleanup_completed_at, /^\d{4}-\d{2}-\d{2}T/);

    updated.cluster = 'kind';
    updated.cleanup_status = undefined;
    updated.cleanup_completed_at = undefined;
    await writeFile(marker, JSON.stringify(updated) + '\n');
    const broad = spawnSync(process.execPath, [cleanup, marker], {
      encoding: 'utf8',
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, S9_FAKE_KIND_LOG: log},
    });
    assert.notEqual(broad.status, 0);
    assert.match(broad.stderr, /exact Section 9 runtime names/i);

    const link = join(parent, '.section-9-kind-run.json');
    await symlink(marker, link);
    const linked = spawnSync(process.execPath, [cleanup, link], {encoding: 'utf8'});
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /symbolic links/i);
    assert.equal((await lstat(marker)).isFile(), true);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

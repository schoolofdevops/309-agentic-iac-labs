import assert from 'node:assert/strict';
import {access, chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const section = resolve(import.meta.dirname, '..');
const evaluator = resolve(section, 'scripts/check-package.mjs');
const runner = resolve(section, '../labs/m9/check-section-9.mjs');
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

async function repairCandidate(source) {
  const valuesPath = join(source, 'chart/values.yaml');
  let values = await readFile(valuesPath, 'utf8');
  values = values.replace(
    '  # Seeded learner defect: generated token material must not live in values.\n  token: s9-course-token-committed',
    '  existingSecret:\n    name: inference-platform-backend-token\n    key: token',
  );
  values = values.replace(
    '  worker:\n    requests:\n      cpu: 10m\n      memory: 32Mi\n',
    '  worker:\n    requests:\n      cpu: 10m\n      memory: 32Mi\n    limits:\n      cpu: 100m\n      memory: 64Mi\n',
  );
  await writeFile(valuesPath, values);

  const schemaPath = join(source, 'chart/values.schema.json');
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  schema.properties.backend.required = ['url', 'existingSecret'];
  delete schema.properties.backend.properties.token;
  schema.properties.backend.properties.existingSecret = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'key'],
    properties: {
      name: {type: 'string', minLength: 1},
      key: {type: 'string', minLength: 1},
    },
  };
  schema.properties.resources.properties.worker = {$ref: '#/definitions/resources'};
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  const deploymentPath = join(source, 'chart/templates/deployment.yaml');
  const deployment = await readFile(deploymentPath, 'utf8');
  const rangeOffset = deployment.indexOf('{{- range $role');
  assert.notEqual(rangeOffset, -1);
  const repaired = `{{- $root := . -}}\n${deployment.slice(rangeOffset)}`
    .replace('name: inference-platform-backend-token', 'name: {{ $root.Values.backend.existingSecret.name }}')
    .replace('- key: token\n                      path: token', '- key: {{ $root.Values.backend.existingSecret.key }}\n                      path: token');
  await writeFile(deploymentPath, repaired);
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

test('evaluator rejects nested symlinks and pre-existing output', async () => {
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
  const original = await readFile(evaluator, 'utf8');
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
      const output = join(parent, `agentic-iac-section-9-${name.replaceAll(' ', '-')}`);
      try {
        await writeFile(join(source, 'scripts/check-package.mjs'), original.replace(needle, replacement));
        const result = runEvaluator(runner, source, output);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /protected file hash mismatch/i);
        await assert.rejects(access(output));
      } finally {
        await rm(parent, {recursive: true, force: true});
      }
    });
  }
});

test('exact resource quantities reject wrong values for multiple roles', async (t) => {
  const cases = [
    ['API CPU request', '  api:\n    requests:\n      cpu: 10m\n      memory: 32Mi', '  api:\n    requests:\n      cpu: 20m\n      memory: 32Mi'],
    ['dependencies memory limit', '      cpu: 100m\n      memory: 64Mi\n  api:', '      cpu: 100m\n      memory: 96Mi\n  api:'],
  ];
  for (const [name, needle, replacement] of cases) {
    await t.test(name, async () => {
      const {parent, source} = await temporarySection('section-9-resource-');
      const output = join(parent, `agentic-iac-section-9-${name.replaceAll(' ', '-')}`);
      try {
        await repairCandidate(source);
        const valuesPath = join(source, 'chart/values.yaml');
        const values = await readFile(valuesPath, 'utf8');
        assert.ok(values.includes(needle));
        await writeFile(valuesPath, values.replace(needle, replacement));
        const result = runEvaluator(runner, source, output);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
        assert.equal(report.gates.resource_limits.status, 'FAIL');
        assert.ok(report.primary_findings.some(({id}) => id === 'incorrect-resource-quantities'));
      } finally {
        await rm(parent, {recursive: true, force: true});
      }
    });
  }

  await t.test('rendered resources diverge from correct values', async () => {
    const {parent, source} = await temporarySection('section-9-render-resource-');
    const output = join(parent, 'agentic-iac-section-9-render-resource');
    try {
      await repairCandidate(source);
      const deploymentPath = join(source, 'chart/templates/deployment.yaml');
      const deployment = await readFile(deploymentPath, 'utf8');
      const needle = '{{- index $root.Values.resources $role | toYaml | nindent 12 }}';
      assert.ok(deployment.includes(needle));
      await writeFile(deploymentPath, deployment.replace(needle, '{{- index $root.Values.resources $role | toYaml | replace "64Mi" "96Mi" | nindent 12 }}'));
      const result = runEvaluator(runner, source, output);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
      assert.ok(report.observations.resource_differences.some(({source: resourceSource}) => resourceSource === 'render'));
      assert.ok(report.primary_findings.some(({id}) => id === 'incorrect-resource-quantities'));
    } finally {
      await rm(parent, {recursive: true, force: true});
    }
  });
});

test('secret scan catches assignments in deployment comments and schema literals', async (t) => {
  const cases = [
    ['deployment comment', async (source) => {
      const path = join(source, 'chart/templates/deployment.yaml');
      await writeFile(path, `# backend_password = deployment-secret-value\n${await readFile(path, 'utf8')}`);
      return 'chart/templates/deployment.yaml';
    }],
    ['schema literal', async (source) => {
      const path = join(source, 'chart/values.schema.json');
      const schema = JSON.parse(await readFile(path, 'utf8'));
      schema.properties.backend.properties.url.default = 'schema-secret-value';
      await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`);
      return 'chart/values.schema.json';
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const {parent, source} = await temporarySection('section-9-secret-source-');
      const output = join(parent, `agentic-iac-section-9-${name.replaceAll(' ', '-')}`);
      try {
        await repairCandidate(source);
        const expectedFile = await mutate(source);
        const result = runEvaluator(runner, source, output);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const reportText = await readFile(join(output, 'evidence-report.json'), 'utf8');
        const report = JSON.parse(reportText);
        assert.equal(report.gates.secret_scan.status, 'FAIL');
        assert.ok(report.primary_findings.some(({id}) => id === 'committed-backend-token-material'));
        assert.ok(report.observations.secret_source_findings.some(({file}) => file === expectedFile));
        assert.doesNotMatch(reportText, /deployment-secret-value|schema-secret-value/);
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

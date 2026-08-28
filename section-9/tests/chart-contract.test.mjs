import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const section = resolve(import.meta.dirname, '..');
const runner = resolve(section, '../labs/m9/check-section-9.mjs');
const read = (path) => readFile(resolve(section, path), 'utf8');

test('starter chart contains only the two approved defect families', async () => {
  const values = await read('chart/values.yaml');
  const schema = JSON.parse(await read('chart/values.schema.json'));
  const deployment = await read('chart/templates/deployment.yaml');
  const policy = await read('policy/workload.rego');

  assert.match(values, /backend:\s*[\s\S]*?token:\s*[^\s]+/);
  assert.match(deployment, /kind:\s*Secret/);
  assert.match(deployment, /b64enc/);
  assert.deepEqual(schema.properties.backend.required, ['url', 'token']);
  assert.equal(schema.properties.backend.properties.existingSecret, undefined);

  assert.match(values, /worker:\s*[\s\S]*?requests:\s*[\s\S]*?memory:\s*32Mi/);
  const worker = schema.properties.resources.properties.worker;
  assert.deepEqual(worker.required, ['requests']);
  assert.equal(worker.properties.limits, undefined);
  for (const role of ['dependencies', 'api']) {
    assert.match(values, new RegExp(`${role}:[\\s\\S]*?requests:[\\s\\S]*?cpu: 10m[\\s\\S]*?memory: 32Mi[\\s\\S]*?limits:[\\s\\S]*?cpu: 100m[\\s\\S]*?memory: 64Mi`));
  }

  for (const required of [
    'automountServiceAccountToken: false',
    'runAsUser: 65532',
    'runAsGroup: 65532',
    'fsGroup: 65532',
    'readOnlyRootFilesystem: true',
    'allowPrivilegeEscalation: false',
    'path: /healthz',
    'path: /readyz',
  ]) assert.ok(deployment.includes(required), `missing ${required}`);
  assert.match(policy, /requires a CPU limit/);
  assert.match(policy, /requires a memory limit/);
  assert.match(policy, /must run as non-root/);
  assert.match(policy, /requires an HTTP readiness probe/);
});

test('starter passes Helm lint', () => {
  const result = spawnSync('helm', ['lint', '--strict', resolve(section, 'chart')], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('independent evaluator reports exactly two primary findings and keeps unrelated gates green', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-9-evaluator-'));
  const output = join(parent, 'agentic-iac-section-9-starter');
  try {
    const result = spawnSync(process.execPath, [runner, section, output], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Section 9 package: REJECTED/);
    assert.doesNotMatch(result.stdout, /READY_FOR_HUMAN_REVIEW/);

    const reportText = await readFile(join(output, 'evidence-report.json'), 'utf8');
    const report = JSON.parse(reportText);
    assert.equal(report.schema, 'agentic-iac-section-9-evidence/v1');
    assert.equal(report.decision, 'REJECTED');
    assert.deepEqual(report.primary_findings.map(({id}) => id), [
      'committed-backend-token-material',
      'missing-worker-resource-limits',
    ]);
    assert.equal(report.primary_findings.length, 2);
    for (const gate of ['app_tests', 'helm_lint', 'render', 'kubeconform', 'workload_contract', 'security_context', 'probes', 'role_boundaries', 'allowed_source_scope']) {
      assert.equal(report.gates[gate].status, 'PASS', `${gate} was not green`);
    }
    for (const gate of ['schema', 'secret_scan', 'resource_limits', 'conftest']) {
      assert.equal(report.gates[gate].status, 'FAIL', `${gate} did not expose an approved defect`);
    }
    assert.match(report.source_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.evaluator_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.artifacts.app_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.artifacts.chart_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.artifacts.render_sha256, /^[a-f0-9]{64}$/);
    assert.ok(report.commands.length >= 10);
    assert.ok(report.commands.every((command) => Array.isArray(command.argv) && Number.isInteger(command.exit)));
    assert.ok(report.proof_limits.some((limit) => /does not create a Kind cluster/i.test(limit)));
    assert.ok(report.proof_limits.some((limit) => /NetworkPolicy enforcement/i.test(limit)));

    assert.doesNotMatch(reportText, /s9-course-token-committed/);
    assert.deepEqual((await readdir(output)).sort(), ['.section-9-evaluation.json', 'evidence-report.json']);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('publishes one bounded Section 9 repair request', () => {
  for (const path of [
    'README.md',
    'request.md',
    'task.md',
    'challenge/README.md',
    'scripts/check-package.mjs',
    'scripts/cleanup-kind.mjs',
  ]) {
    assert.equal(existsSync(new URL(path, root)), true, `missing ${path}`);
  }

  const request = read('request.md');
  const taskContract = read('task.md');
  assert.match(request, /committed backend token material/i);
  assert.match(request, /worker resource limits/i);
  assert.match(taskContract, /app\/.*read-only/i);
  assert.match(taskContract, /chart\/values\.yaml/i);
  assert.match(taskContract, /chart\/values\.schema\.json/i);
  assert.match(taskContract, /chart\/templates\/deployment\.yaml/i);
  assert.match(taskContract, /exactly two primary findings/i);
  assert.match(taskContract, /No Kind cluster, Kubernetes namespace, Helm release, image, apply, or destroy action/i);
});

test('freezes the split workload role and API contracts', () => {
  for (const path of [
    'app/.dockerignore',
    'app/Dockerfile',
    'app/go.mod',
    'app/main.go',
    'app/api.go',
    'app/backend.go',
    'app/worker.go',
    'app/main_test.go',
  ]) {
    assert.equal(existsSync(new URL(path, root)), true, `missing ${path}`);
  }

  const main = read('app/main.go');
  const api = read('app/api.go');
  const backend = read('app/backend.go');
  const worker = read('app/worker.go');
  const workloadTests = read('app/main_test.go');

  for (const role of ['dependencies', 'api', 'worker']) assert.match(main, new RegExp(`"${role}"`));
  assert.match(main, /BACKEND_TOKEN_FILE/);
  assert.match(main, /os\.ReadFile/);
  assert.match(api, /POST \/jobs/);
  assert.match(api, /GET \/jobs\/\{id\}/);
  assert.match(api, /GET \/readyz/);
  assert.match(backend, /subtle\.ConstantTimeCompare/);
  assert.match(backend, /Bearer /);
  assert.match(worker, /MOCK INFERENCE: /);
  assert.match(worker, /__fail__/);
  for (const contract of [
    'TestAPISubmissionReturnsQueuedJob',
    'TestWorkerClaimsAndCompletesDeterministicJob',
    'TestSeededFailureIsTerminalAndNotRetried',
    'TestBackendRejectsIncorrectTokenWithoutEchoingIt',
    'TestMissingTokenFileFailsStartup',
    'TestAPIReadinessFailsWhenBackendIsUnavailable',
    'TestHTTPServerShutsDownCleanly',
  ]) assert.match(workloadTests, new RegExp(contract));
});

test('starter application tests pass without a cluster', () => {
  const result = spawnSync('go', ['test', './...'], {
    cwd: new URL('app/', root),
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the evaluator is plan-free and uses fixed non-shell commands', () => {
  const evaluator = read('scripts/check-package.mjs');
  assert.match(evaluator, /shell:\s*false/);
  for (const fixed of [
    "['test', './...']",
    "['lint', '--strict'",
    "['template', 'inference-platform'",
    "['-strict', '-summary', '-']",
    "['test', '-', '-p'",
  ]) assert.ok(evaluator.includes(fixed), `missing fixed arguments ${fixed}`);
  assert.doesNotMatch(evaluator, /\b(terraform|tofu|kubectl|docker)\b/);
  assert.doesNotMatch(evaluator, /\b(apply|destroy)\b/);
});

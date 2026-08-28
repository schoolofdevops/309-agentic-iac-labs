import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('diagnostic challenge contains exactly the three planned failures', () => {
  const task = read('challenge/task.md');
  const key = read('challenge/answer-key.md');
  const failureIds = [
    'wrong-helm-value',
    'bad-readiness-path',
    'unreachable-backend-connection',
  ];
  assert.deepEqual([...task.matchAll(/^## Failure \d: `([^`]+)`$/gm)].map((match) => match[1]), failureIds);
  assert.deepEqual([...key.matchAll(/^## Failure \d: `([^`]+)`$/gm)].map((match) => match[1]), failureIds);
  assert.equal((task.match(/^## Failure /gm) || []).length, 3);
  assert.equal((key.match(/^## Failure /gm) || []).length, 3);
});

test('challenge requires runtime evidence before diagnosis', () => {
  const task = read('challenge/task.md');
  const evidenceOffset = task.indexOf('## Collect evidence before diagnosis');
  const diagnosisOffset = task.indexOf('## Write your diagnosis');
  assert(evidenceOffset >= 0 && diagnosisOffset > evidenceOffset);
  for (const evidence of ['get pods', 'get events', 'get endpoints', 'describe', 'logs', 'get values', 'get manifest']) {
    assert.match(task, new RegExp(evidence));
  }
  assert.match(task, /Do not open the answer key until/i);
});

test('challenge recovery is exact and preserves the proof boundary', () => {
  const task = read('challenge/task.md');
  const key = read('challenge/answer-key.md');
  for (const content of [task, key]) {
    assert.match(content, /agentic-iac-s9/);
    assert.match(content, /kind-agentic-iac-s9/);
    assert.match(content, /inference-platform/);
    assert.match(content, /namespace inference/i);
    assert.match(content, /NetworkPolicy.*not.*enforcement/is);
    assert.doesNotMatch(content, /rm -rf|git reset --hard|terraform apply|tofu apply/);
  }
  assert.match(key, /helm upgrade/);
  assert.match(key, /rollout status/);
});

test('pinned recovery patch is the exact three-file candidate diff', () => {
  const candidate = '718fd28edab8a026bab114c0f21800e2df450c83';
  const baseline = 'fdcc15c57c9879b3f15d03319ad5dd394e2706f2';
  const paths = [
    'section-9/chart/templates/deployment.yaml',
    'section-9/chart/values.schema.json',
    'section-9/chart/values.yaml',
  ];
  const patch = read(`recovery/${candidate}.patch`);
  const expected = execFileSync('/usr/bin/git', ['diff', '--binary', `${baseline}..${candidate}`, '--', ...paths], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(patch, expected);
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => [match[1], match[2]]), paths.map((path) => [path, path]));
});

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('diagnostic challenge contains exactly the three planned failures', () => {
  const task = read('challenge/task.md');
  const key = read('challenge/answer-key.md');
  assert.match(task, /^# Advanced Live Diagnostics Lab: Diagnose Three Kubernetes and Helm Failures$/m);
  const failureIds = [
    'bad-readiness-path',
    'unreachable-backend-connection',
    'wrong-helm-value',
  ];
  assert.deepEqual([...task.matchAll(/^## Failure \d: `([^`]+)`$/gm)].map((match) => match[1]), failureIds);
  assert.deepEqual([...key.matchAll(/^## Failure \d: `([^`]+)`$/gm)].map((match) => match[1]), failureIds);
  assert.equal((task.match(/^## Failure /gm) || []).length, 3);
  assert.equal((key.match(/^## Failure /gm) || []).length, 3);
});

test('challenge injects, observes, diagnoses, and recovers each failure before the next', () => {
  const task = read('challenge/task.md');
  const sections = [...task.matchAll(/^## Failure \d: `([^`]+)`$/gm)];
  for (let index = 0; index < sections.length; index += 1) {
    const start = sections[index].index;
    const end = sections[index + 1]?.index ?? task.length;
    const section = task.slice(start, end);
    const stages = ['### Inject the failure', '### Observe before diagnosis', '### Write your diagnosis', '### Recover and prove the repair'];
    let previous = -1;
    for (const stage of stages) {
      const offset = section.indexOf(stage);
      assert(offset > previous, `${sections[index][1]} must place ${stage} after the previous stage`);
      previous = offset;
    }
    for (const evidence of ['get pods', 'rollout status', 'get events', 'get endpointslices', 'describe deployment', 'logs', 'get manifest']) {
      assert.match(section, new RegExp(evidence), `${sections[index][1]} must collect ${evidence}`);
    }
    assert.match(section, /Do not diagnose until/i);
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

test('challenge uses portable evidence filters and exact one-line NodePort output', () => {
  const task = read('challenge/task.md');
  assert.doesNotMatch(task, /\b(?:command\s+)?rg\b/);
  assert.match(task, /\| command awk 'NR==1 \|\| \(\/inference-platform-api\/ && \/statuscode: 404\/\)'/);
  assert.doesNotMatch(task, /grep -E 'inference-platform-api\|LAST SEEN'/);
  assert.match(task, /\| command grep 'path: \/readyz'/);
  assert.match(task, /\| command grep -E 'inference-platform-worker\|LAST SEEN'/);
  assert.match(task, /yq 'select\(\.kind == "Deployment" and \.metadata\.name == "inference-platform-worker"\)[^']+select\(\.name == "BACKEND_URL"\)'/);
  assert.doesNotMatch(task, /awk '\/name: BACKEND_URL/);
  assert.match(task, /```text\n\{\n  "name": "BACKEND_URL",[\s\S]*?"key": "BACKEND_URL"[\s\S]*?\n\}\n```/);

  const nodePortCommand = /\| command awk '\/nodePort:\/\{print "nodePort:", \$2; exit\}'/g;
  assert.equal((task.match(nodePortCommand) || []).length, 3);
  assert.equal((task.match(/```text\nnodePort: 30081\n```/g) || []).length, 2);
  assert.equal((task.match(/```text\nnodePort: 30080\n```/g) || []).length, 1);
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

test('documented recovery preserves an attempt and unrelated work before restoring only three files', () => {
  const candidate = '718fd28edab8a026bab114c0f21800e2df450c83';
  const baseline = 'fdcc15c57c9879b3f15d03319ad5dd394e2706f2';
  const paths = [
    'section-9/chart/templates/deployment.yaml',
    'section-9/chart/values.schema.json',
    'section-9/chart/values.yaml',
  ];
  const repo = new URL('../../', import.meta.url).pathname;
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'section-9-recovery-'));
  const clone = join(temporaryRoot, 'learner');
  const runGit = (...args) => execFileSync('/usr/bin/git', args, {cwd: clone, encoding: 'utf8'});

  try {
    execFileSync('/usr/bin/git', ['clone', '--quiet', repo, clone]);
    for (const path of paths) writeFileSync(join(clone, path), `\n# learner partial edit: ${path}\n`, {flag: 'a'});
    writeFileSync(join(clone, 'section-9/request.md'), '\nLearner note outside recovery scope.\n', {flag: 'a'});

    const attempt = runGit('diff', '--binary', 'HEAD', '--', ...paths);
    writeFileSync(join(temporaryRoot, 'section-9-learner-attempt.patch'), attempt);
    runGit('restore', '--source', baseline, '--staged', '--worktree', '--', ...paths);
    runGit('apply', '--check', `section-9/recovery/${candidate}.patch`);
    runGit('apply', `section-9/recovery/${candidate}.patch`);

    assert.equal(runGit('diff', '--binary', baseline, '--', ...paths), read(`recovery/${candidate}.patch`));
    assert.match(readFileSync(join(clone, 'section-9/request.md'), 'utf8'), /Learner note outside recovery scope/);
    for (const path of paths) assert.match(attempt, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

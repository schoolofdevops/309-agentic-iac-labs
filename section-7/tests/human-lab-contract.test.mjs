import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('publishes a human-first Section 7 learner path', () => {
  const lab = read('README.md');
  for (const part of ['PART I', 'PART II', 'PART III', 'PART IV', 'PART V', 'PART VI', 'Checkpoint', 'Teardown']) {
    assert.match(lab, new RegExp(part));
  }
  assert.match(lab, /why|because/i);
  assert.match(lab, /pwd/);
  assert.match(lab, /ls section-7/);
  assert.match(lab, /sed -n/);
  assert.match(lab, /continue unless Docker or a tool reports a real\s+failure/i);
});

test('demonstrates Codex once while keeping the lab agent neutral', () => {
  const lab = read('README.md');
  assert.match(lab, /```bash\ncodex\n```/);
  for (const name of ['Claude Code', 'Goose', 'Cursor', 'Copilot', 'VS Code', 'Manual editing']) {
    assert.match(lab, new RegExp(name, 'i'));
  }
  assert.match(lab, /same task/i);
});

test('pins recovery to the four learner-owned artifacts', () => {
  const lab = read('README.md');
  assert.match(lab, /ca2a5fd324a8007cf14efc827d1edc9d25044fcb/);
  const restore = lab.match(/git restore --source=[\s\S]*?compatibility-record\.md/)?.[0] || '';
  assert.match(restore, /starter\/versions\.tf/);
  assert.match(restore, /starter\/outputs\.tf/);
  assert.match(restore, /starter\/modules\/identity\/main\.tf/);
  assert.match(restore, /compatibility-record\.md/);
  assert.doesNotMatch(restore, /scripts|tests|phase-0/);
});

test('keeps local apply explicit, bounded, evidenced, and separate from production', () => {
  const lab = read('README.md');
  assert.match(lab, /explicit approval for this one disposable\s+local run/i);
  assert.match(lab, /not approval for a real-cloud plan or apply/i);
  assert.match(lab, /--endpoint http:\/\/localhost\.floci\.io:4566/);
  assert.match(lab, /--prefix s7-learner-tf/);
  assert.match(lab, /--prefix s7-learner-tofu/);
  assert.match(lab, /human_approval_required/);
  assert.match(lab, /direct API lists are empty after destroy/);
});

test('avoids bot-oriented learner commands and broad destructive cleanup', () => {
  const lab = read('README.md');
  for (const pattern of [/\btest -[efd]\b/, /\bfind\s+section-7/, /\.agent-choice/, /node -e/, /rm -rf/, /git reset --hard/]) {
    assert.doesNotMatch(lab, pattern);
  }
});

test('provides an independent four-signal plan challenge and separate key', () => {
  const challenge = read('challenge/plan-review.md');
  const key = read('challenge/answer-key.md');
  for (const signal of ['update in-place', 'replace', 'known after apply', 'moved to']) assert.match(challenge, new RegExp(signal));
  assert.match(challenge, /Do not apply/);
  assert.match(key, /bucket replacement must stop/i);
  assert.match(key, /zero create and zero destroy/i);
  assert.doesNotMatch(challenge, /Recommended verdict/);
});

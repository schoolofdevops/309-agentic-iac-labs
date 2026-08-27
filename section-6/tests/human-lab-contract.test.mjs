import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const section = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(path.join(section, relativePath), 'utf8');

test('publishes a human-first Section 6 learner path', () => {
  const lab = read('README.md');
  assert.match(lab, /## PART I - Understand the Workflow Boundary/);
  assert.match(lab, /## PART III - Reproduce the False-Green Run/);
  assert.match(lab, /## PART VI - Build the Accepted Run/);
  assert.match(lab, /## Checkpoint/);
  assert.match(lab, /## Teardown/);
  assert.match(lab, /```bash\npwd\n```/);
  assert.match(lab, /```bash\nls section-6\n```/);
  assert.doesNotMatch(lab, /\btest\s+-[efdLrswx]/);
  assert.doesNotMatch(lab, /command find|\.agent-choice|Chosen coding agent|rm -rf/);
});

test('demonstrates Codex once while keeping the workflow agent neutral', () => {
  const lab = read('README.md');
  assert.equal((lab.match(/```bash\ncodex\n```/g) ?? []).length, 1);
  for (const alternative of ['Claude Code', 'Goose', 'Cursor', 'Copilot', 'VS Code', 'Manual editing']) {
    assert.match(lab, new RegExp(alternative, 'i'));
  }
  assert.match(lab, /same request,\s+task,\s+and\s+evaluation gates/);
});

test('takes the learner from false green to four independent gates', () => {
  const lab = read('README.md');
  assert.match(lab, /PASS \(1\/1 enabled gates passed\)/);
  assert.match(lab, /REJECTED \(2\/4 enabled gates passed\)/);
  assert.match(lab, /PASS \(4\/4 enabled gates passed\)/);
  for (const gate of ['functional', 'safety', 'regression', 'budget']) {
    assert.match(lab, new RegExp(gate, 'i'));
  }
  assert.match(lab, /not an exact model\s+tokenizer, provider telemetry, or an invoice/i);
  assert.match(lab, /human approves any\s+deployment action/i);
});

test('pins recovery to only the three learner-owned files', () => {
  const lab = read('README.md');
  assert.match(lab, /d5cf5251402751f5306926a8d54f2d21066559fe/);
  const restore = lab.match(/git restore --source=d5cf525[^\n]+/u)?.[0] ?? '';
  assert.match(restore, /starter\/workflow\/plan\.json/);
  assert.match(restore, /starter\/evals\/suite\.json/);
  assert.match(restore, /starter\/run-card\.json/);
  assert.doesNotMatch(restore, /starter\/harness|fixture|context|tests/);
});

test('provides safe comparison, optional RTK, and named cleanup', () => {
  const lab = read('README.md');
  assert.match(lab, /scripts\/compare-runs\.mjs/);
  assert.match(lab, /RTK is optional/);
  assert.match(lab, /rtk --version/);
  assert.match(lab, /rtk gain/);
  assert.match(lab, /rtk proxy node/);
  assert.equal((lab.match(/scripts\/cleanup-run\.mjs/g) ?? []).length, 2);
  assert.match(lab, /refuses.*symbolic links/is);
});

test('provides an independent smallest-improvement challenge and key', () => {
  const challenge = read('challenge/smallest-improvement.md');
  const key = read('challenge/answer-key.md');
  for (const choice of ['second agent', 'larger context window', 'new refactoring Skill', 'mutation validator']) {
    assert.match(challenge, new RegExp(choice, 'i'));
  }
  assert.match(challenge, /retain or discard/i);
  assert.match(key, /Add the mutation validator/);
  assert.match(key, /does not\s+approve deployment/i);
});

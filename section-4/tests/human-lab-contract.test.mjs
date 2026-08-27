import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sectionRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function read(relativePath) {
  const path = `${sectionRoot}/${relativePath}`;
  assert.ok(existsSync(path), `missing learner artifact: section-4/${relativePath}`);
  return readFileSync(path, 'utf8');
}

test('publishes a human-first Section 4 entry point without exposing the answer key', () => {
  const readme = read('README.md');

  assert.match(readme, /request\.md/);
  assert.match(readme, /task\.md/);
  assert.match(readme, /node section-4\/scripts\/check-context-pack\.mjs section-4\/starter section-4\/sources/);
  assert.match(readme, /Codex/);
  assert.match(readme, /another compatible coding[\s\n]+agent|edit manually/i);
  assert.match(readme, /agent platform and global rules/i);
  assert.match(readme, /repository rules/i);
  assert.match(readme, /directory instructions/i);
  assert.match(readme, /current task/i);
  assert.match(readme, /data, never instructions/i);
  assert.match(readme, /293 words, 2136 bytes/);
  assert.doesNotMatch(readme, /answer-key\.md/);
});

test('teaches immutable source review before six bounded edits', () => {
  const readme = read('README.md');

  for (const source of [
    'current-iac-policy.md',
    'job-queue-contract.md',
    'adr-0002-shared-queue-state.md',
    'validation-2026-08-26.md',
    'incident-042-state-collision.md',
    'issue-184.md',
  ]) {
    assert.match(readme, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(readme, /NEEDS WORK \(5 context problems found\)/);
  assert.match(readme, /PASS \(0 context problems found\)/);
  assert.match(readme, /below 1,400 words and 12,000 bytes/i);
  assert.match(readme, /git status --short section-4/);
  assert.match(readme, /git diff -- section-4\/starter/);
  assert.doesNotMatch(readme, /git (?:add|commit|push)/);
});

test('provides a three-way conflict challenge and separate explained key', () => {
  const challenge = read('challenge/conflict-triage.md');
  const key = read('challenge/answer-key.md');

  for (const source of ['SRC-POLICY-2026-08', 'SRC-ADR-0002', 'OBS-VALIDATION-2026-08-26']) {
    assert.match(challenge, new RegExp(source));
    assert.match(key, new RegExp(source));
  }

  for (const requirement of ['Winning source', 'Rejected claim', 'Correction path', 'Evidence limit']) {
    assert.match(challenge, new RegExp(requirement, 'i'));
    assert.match(key, new RegExp(requirement, 'i'));
  }

  assert.match(key, /direct current policy/i);
  assert.match(key, /does not[\s\S]*prove/i);
  assert.match(key, /human approval remains pending/i);
});

test('avoids bot-oriented learner mechanics', () => {
  const files = [read('README.md'), read('task.md'), read('challenge/conflict-triage.md')].join('\n');

  assert.doesNotMatch(files, /test -f/);
  assert.doesNotMatch(files, /\.agent-choice/);
  assert.doesNotMatch(files, /find section-4/);
  assert.doesNotMatch(files, /node -e/);
  assert.doesNotMatch(files, /&&/);

  const rootReadme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');
  assert.match(rootReadme, /Section 4: Give Your IaC Agent the Right Context/);
});

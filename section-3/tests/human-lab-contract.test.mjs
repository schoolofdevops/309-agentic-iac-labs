import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sectionRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function read(relativePath) {
  const path = `${sectionRoot}/${relativePath}`;
  assert.ok(existsSync(path), `missing learner artifact: section-3/${relativePath}`);
  return readFileSync(path, 'utf8');
}

test('publishes a human-first Section 3 entry point without exposing the answer key', () => {
  const readme = read('README.md');

  assert.match(readme, /task\.md/);
  assert.match(readme, /request\.md/);
  assert.match(readme, /node section-3\/scripts\/check-design-pack\.mjs section-3\/starter/);
  assert.match(readme, /@finos\/calm-cli@1\.57\.0 validate/);
  assert.match(readme, /Codex/);
  assert.match(readme, /compatible coding agent|edit manually/i);
  assert.match(readme, /"interacts"/);
  assert.match(readme, /"actor": "api-client"/);
  assert.match(readme, /"nodes": \["workload-api"\]/);
  assert.doesNotMatch(readme, /answer-key\.md/);
});

test('keeps the portable task bounded to four design artifacts', () => {
  const task = read('task.md');

  for (const artifact of [
    'change-brief.md',
    'environment-state-map.md',
    'decisions/0001-queue-ownership.md',
    'architecture/queue-feature.calm.json',
  ]) {
    assert.match(task, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(task, /separate Terraform state/i);
  assert.match(task, /job payload/i);
  assert.match(task, /trust boundar/i);
  assert.match(task, /client-to-API/i);
  assert.match(task, /AMQP queue interfaces/i);
  assert.match(task, /separate TLS security/i);
  assert.match(task, /not\s+proof of runtime enforcement/i);
  assert.match(task, /security approval/i);
  assert.match(task, /Do not[\s\S]*implementation code/i);
  assert.match(task, /Do not[\s\S]*(?:apply|deploy)/i);
  assert.match(task, /human\s+approval/i);
  assert.doesNotMatch(task, /\b(?:Codex|Claude|Goose|Cursor|Copilot|Hermes)\b/);
});

test('provides a twelve-setting lifecycle challenge and a separate explained key', () => {
  const challenge = read('challenge/settings-to-place.md');
  const key = read('challenge/answer-key.md');
  const settingRows = challenge.match(/^\|\s*\d+\s*\|/gm) ?? [];

  assert.equal(settingRows.length, 12, 'the operator challenge must contain exactly 12 settings');
  for (const owner of [
    'Terraform',
    'Helm',
    'GitOps',
    'Application configuration',
    'Secret management',
  ]) {
    assert.match(challenge, new RegExp(owner, 'i'));
    assert.match(key, new RegExp(owner, 'i'));
  }
  assert.match(challenge, /change lifecycle/i);
  assert.match(key, /secret reference/i);
  assert.match(key, /secret value/i);
  assert.match(key, /why/i);
});

test('avoids bot-oriented learner mechanics', () => {
  const files = [
    read('README.md'),
    read('task.md'),
    read('challenge/settings-to-place.md'),
  ].join('\n');

  assert.doesNotMatch(files, /test -f/);
  assert.doesNotMatch(files, /\.agent-choice/);
  assert.doesNotMatch(files, /find section-3/);
  assert.doesNotMatch(files, /&&/);

  const rootReadme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');
  assert.match(rootReadme, /Section 3: Plan Your IaC Change Before the Agent Writes Code/);
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sectionRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function read(relativePath) {
  const path = `${sectionRoot}/${relativePath}`;
  assert.ok(existsSync(path), `missing learner artifact: section-5/${relativePath}`);
  return readFileSync(path, 'utf8');
}

test('publishes a human-first Section 5 entry point without exposing the answer key', () => {
  const readme = read('README.md');

  assert.match(readme, /request\.md/);
  assert.match(readme, /task\.md/);
  assert.match(readme, /Codex/);
  assert.match(readme, /Claude Code, Goose, Cursor, Copilot, VS Code/);
  assert.match(readme, /Manual\s+editing is also supported/);
  assert.match(readme, /CLI for deterministic checks/i);
  assert.match(readme, /Skill for a reusable procedure/i);
  assert.match(readme, /MCP for one approved context resource/i);
  assert.match(readme, /node section-5\/starter\/mcp\/probe\.mjs/);
  assert.match(readme, /node section-5\/scripts\/check-capability-pack\.mjs section-5\/starter section-5\/incoming/);
  assert.doesNotMatch(readme, /challenge\/answer-key\.md/);
});

test('takes the learner from five findings to bounded evidence and a passing decision', () => {
  const readme = read('README.md');

  assert.match(readme, /NEEDS WORK \(5 capability problems found\)/);
  assert.match(readme, /PASS \(0 capability problems found\)/);
  assert.match(readme, /cd89867c8401fc1a7f6ddcef56f0aa410d0acbc8/);
  assert.match(readme, /--engine terraform --evidence terraform-review\.json/);
  assert.match(readme, /section-5\/starter\/evidence\/terraform-review\.json/);
  assert.match(readme, /Skill metadata, MCP annotations, and server identity|metadata and[\s\S]*server identity/i);
  assert.match(readme, /operating-system permissions/i);
  assert.match(readme, /identity and consent/i);
  assert.match(readme, /human approval/i);
  assert.doesNotMatch(readme, /git (?:add|commit|push)/);
});

test('provides an independent capability admission challenge and separate key', () => {
  const challenge = read('challenge/capability-admission.md');
  const key = read('challenge/answer-key.md');

  for (const requirement of [/owner/i, /revocation/i, /human\s+approval/i, /readOnlyHint/i]) {
    assert.match(challenge, requirement);
    assert.match(key, requirement);
  }

  assert.match(challenge, /artifact hash/i);
  assert.match(key, /exact packaged hash|matching hash/i);
  assert.match(challenge, /Do not install or run either capability/i);
  assert.match(key, /Updated Skill: defer/i);
  assert.match(key, /Updated server: reject/i);
  assert.match(key, /does not prove|do not prove/i);
});

test('avoids bot-oriented learner mechanics and destructive recursive cleanup', () => {
  const files = [read('README.md'), read('task.md'), read('challenge/capability-admission.md')].join('\n');

  assert.doesNotMatch(files, /test -f/);
  assert.doesNotMatch(files, /\.agent-choice/);
  assert.doesNotMatch(files, /find section-5/);
  assert.doesNotMatch(files, /node -e/);
  assert.doesNotMatch(files, /&&|\|\|/);
  assert.doesNotMatch(files, /rm -rf/);

  const rootReadme = readFileSync(`${repositoryRoot}/README.md`, 'utf8');
  assert.match(rootReadme, /Section 5: Connect Your IaC Agent to Tools, Skills, and MCP/);
});

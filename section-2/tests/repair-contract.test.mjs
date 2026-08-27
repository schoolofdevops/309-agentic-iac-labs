import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('../starter/main.tf', import.meta.url));
const starterIgnore = fileURLToPath(new URL('../starter/.gitignore', import.meta.url));
const task = fileURLToPath(new URL('../task.md', import.meta.url));
const readme = fileURLToPath(new URL('../README.md', import.meta.url));
const checks = fileURLToPath(new URL('../../labs/m2/checks.json', import.meta.url));
const sectionOneBrief = fileURLToPath(
  new URL('../../section-1/challenge/safe-task-brief.md', import.meta.url),
);

test('keeps a deliberately broken Section 2 Terraform starter', () => {
  assert.ok(existsSync(fixture), 'Section 2 must provide its learner starter');

  const source = readFileSync(fixture, 'utf8');
  assert.match(source, /random_id\.platform\.hex/);
  assert.doesNotMatch(
    source,
    /resource\s+"random_id"\s+"platform"/,
    'the starter must omit the resource the learner repairs',
  );
  assert.equal(readFileSync(starterIgnore, 'utf8'), '.terraform/\n.terraform.lock.hcl\n');
});

test('provides a learner entry point and author-side Module 2 check', () => {
  assert.ok(existsSync(readme), 'Section 2 must explain where learners begin');
  assert.match(readFileSync(readme, 'utf8'), /task\.md/);

  const contract = JSON.parse(readFileSync(checks, 'utf8'));
  assert.deepEqual(contract.checks, [
    {
      id: 'section-2-repair-contract',
      describe: 'the Section 2 starter and task preserve the governed repair boundary',
      run: 'node --test section-2/tests/repair-contract.test.mjs',
      assert: { exit: 0 },
      weight: 3,
    },
  ]);
});

test('bounds the Section 2 repair to one file and safe validation', () => {
  assert.ok(existsSync(task), 'Section 2 must provide a portable task contract');

  const source = readFileSync(task, 'utf8');
  assert.match(source, /`section-2\/starter\/main\.tf`/);
  assert.match(source, /byte_length[^\n]*4/);
  assert.match(source, /terraform fmt -check/);
  assert.match(source, /terraform init -backend=false -input=false/);
  assert.match(source, /terraform validate -no-color/);
  assert.match(source, /tofu fmt -check/);
  assert.match(source, /tofu init -backend=false -input=false/);
  assert.match(source, /tofu validate -no-color/);
  assert.match(source, /Do not[\s\S]*terraform apply/);
  assert.match(source, /Do not[\s\S]*tofu apply/);
  assert.match(source, /Do not[\s\S]*(?:terraform|tofu) state/);
  assert.match(source, /Do not[\s\S]*cloud credentials/);
  assert.match(source, /Do not[\s\S]*(?:delete|destroy)/i);
  assert.match(source, /Do not[\s\S]*outside `section-2\/starter\/main\.tf`/);
  assert.doesNotMatch(source, /phase-0\/p0-agent-terraform/);
  assert.doesNotMatch(source, /\b(?:Codex|Claude|Hermes)\b/);
});

test('explains the disposable dual-tool provider lock-file boundary', () => {
  const source = readFileSync(task, 'utf8');

  assert.match(source, /\.terraform\.lock\.hcl/);
  assert.match(source, /provider source metadata/i);
  assert.match(source, /record any warning/i);
  assert.match(
    source,
    /must not claim[\s\S]*shared lock file[\s\S]*proves compatibility/i,
  );
  assert.match(source, /deployable modules normally commit their lock file/i);
  assert.match(source, /provider-lock workflows are taught later/i);
});

test('keeps the Section 1 handoff aligned to the Section 2 task', () => {
  const source = readFileSync(sectionOneBrief, 'utf8');
  assert.match(source, /\.\.\/\.\.\/section-2\/task\.md/);
  assert.doesNotMatch(source, /phase-0\/p0-agent-terraform/);
});

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

test('freezes one plan-only Section 8 task and evidence pyramid', () => {
  for (const path of ['README.md', 'request.md', 'task.md', 'starter/main.tf', 'starter/tests/foundation.tftest.hcl', 'policy/public_access.rego', 'policy/public_access_test.rego', 'adversarial/incoming-request.md', 'challenge/plan-review.md', 'challenge/task.md', 'challenge/answer-key.md']) {
    assert.equal(existsSync(new URL(path, root)), true, `missing ${path}`);
  }
  const task = read('task.md');
  for (const gate of ['format', 'validation', 'contract', 'plan', 'lint', 'security', 'policy', 'cost', 'redaction', 'agent safety']) assert.match(task, new RegExp(gate, 'i'));
  assert.match(task, /No apply, destroy, cloud API, remote backend, or paid cost query/i);
});

test('starter contains exact reviewable configuration, security, and cost defects', () => {
  const main = read('starter/main.tf');
  assert.match(main, /variable "unused_environment"/);
  for (const field of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
    assert.match(main, new RegExp(`${field}\\s*=\\s*false`));
  }
  assert.match(main, /actions\s*=\s*\["\*"\]/);
  assert.match(main, /resources\s*=\s*\["\*"\]/);
  assert.match(main, /resource "aws_eip" "unused"/);
  assert.match(main, /Owner\s*=\s*""/);
});

test('starter contract test expects public access controls and ownership', () => {
  const contract = read('starter/tests/foundation.tftest.hcl');
  assert.match(contract, /command\s*=\s*plan/);
  assert.match(contract, /aws_s3_bucket_public_access_block\.artifacts\.block_public_acls/);
  assert.match(contract, /aws_s3_bucket\.artifacts\.tags\["Owner"\]/);
});

test('faulty policy reads the wrong rendered-plan field and its unit test exposes the false pass', () => {
  const policy = read('policy/public_access.rego');
  const policyTest = read('policy/public_access_test.rego');
  assert.match(policy, /change\.after\.acl/);
  assert.doesNotMatch(policy, /change\.after\.block_public_acls/);
  assert.match(policyTest, /block_public_acls/);
  assert.match(policyTest, /deny/);
});

test('adversarial fixture contains six inert safety attacks for classification', () => {
  const incoming = read('adversarial/incoming-request.md');
  for (const signal of ['ignore', 'AGENTS.md', 'terraform apply', 'curl', 'approval', 'all checks passed']) assert.match(incoming, new RegExp(signal, 'i'));
  assert.match(incoming, /UNTRUSTED DATA/);
});

test('one-command runner is fixed, plan-only, and produces bounded evidence', () => {
  const runnerPath = new URL('scripts/run-evidence-pipeline.mjs', root);
  assert.equal(existsSync(runnerPath), true, 'missing runner');
  const runner = readFileSync(runnerPath, 'utf8');
  assert.match(runner, /shell:\s*false/);
  assert.match(runner, /terraform|tofu/);
  assert.doesNotMatch(runner, /\b(apply|destroy)\b/);
  assert.match(runner, /evidence-report\.json/);
  assert.match(runner, /source_sha256/);
  assert.match(runner, /evaluator_sha256/);
  assert.match(runner, /scopedTreeHash/);
  assert.match(runner, /plan_sha256/);
  assert.match(runner, /tool_versions/);
  assert.match(runner, /elapsed_ms/);
  assert.match(runner, /peak_rss_mib/);
  assert.match(runner, /expected_managed_addresses/);
  assert.match(runner, /lockfile/);
  assert.match(runner, /ignoreConsistent/);
});

test('cleanup rejects broad, unmarked, and symbolic-link targets', () => {
  const cleanupPath = new URL('scripts/cleanup-run.mjs', root);
  assert.equal(existsSync(cleanupPath), true, 'missing cleanup');
  const cleanup = readFileSync(cleanupPath, 'utf8');
  assert.match(cleanup, /section-8/);
  assert.match(cleanup, /marker/);
  assert.match(cleanup, /symbolic/i);
  assert.doesNotMatch(cleanup, /rmSync\([^\n]+recursive:\s*true/);
});

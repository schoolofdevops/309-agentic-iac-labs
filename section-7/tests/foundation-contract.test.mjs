import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('freezes one modular local-cloud foundation task', () => {
  for (const file of ['request.md', 'task.md', 'starter/main.tf', 'starter/versions.tf', 'starter/provider.tf', 'starter/variables.tf', 'starter/outputs.tf']) {
    assert.ok(existsSync(new URL(file, root)), `missing ${file}`);
  }
  const task = read('task.md');
  assert.match(task, /Floci-only/i);
  assert.match(task, /Terraform 1\.14\.8/);
  assert.match(task, /OpenTofu 1\.12\.6/);
  assert.match(task, /No real cloud endpoint, real AWS credentials/i);
});

test('models five owned modules and the exact eight-resource matrix', () => {
  const modules = ['storage', 'messaging', 'job-state', 'identity', 'observability'];
  for (const module of modules) {
    assert.ok(existsSync(new URL(`starter/modules/${module}/main.tf`, root)), `missing ${module} module`);
  }
  const configuration = modules.map((module) => read(`starter/modules/${module}/main.tf`)).join('\n');
  const expected = [
    'aws_s3_bucket', 'aws_s3_bucket_versioning', 'aws_s3_bucket_public_access_block',
    'aws_sqs_queue', 'aws_dynamodb_table', 'aws_iam_role',
    'aws_iam_role_policy', 'aws_cloudwatch_log_group',
  ];
  for (const type of expected) assert.match(configuration, new RegExp(`resource\\s+"${type}"`));
  assert.equal((configuration.match(/resource\s+"aws_/g) || []).length, 8);
});

test('keeps the starter three defects visible to the author checker', () => {
  const versions = read('starter/versions.tf');
  const outputs = read('starter/outputs.tf');
  const identity = read('starter/modules/identity/main.tf');
  assert.match(versions, /version\s*=\s*">= 6\.0\.0"/);
  assert.match(outputs, /output\s+"local_endpoint"/);
  assert.doesNotMatch(outputs, /sensitive\s*=\s*true/);
  assert.match(identity, /Action\s*=\s*"\*"/);
  assert.match(identity, /Resource\s*=\s*"\*"/);
});

test('requires explicit local mode and an approved endpoint', () => {
  const variables = read('starter/variables.tf');
  const provider = read('starter/provider.tf');
  assert.match(variables, /variable\s+"local_mode"/);
  assert.ok(variables.includes('localhost\\\\.floci\\\\.io'));
  assert.match(provider, /check\s+"explicit_local_mode"/);
  assert.match(provider, /var\.local_mode \? "test" : null/);
  assert.match(provider, /skip_credentials_validation\s*=\s*true/);
});

test('declares typed module contracts and graph edges', () => {
  const main = read('starter/main.tf');
  assert.match(main, /module\s+"storage"/);
  assert.match(main, /module\s+"messaging"/);
  assert.match(main, /module\s+"job_state"/);
  assert.match(main, /module\s+"identity"/);
  assert.match(main, /module\s+"observability"/);
  assert.match(main, /bucket_arn\s*=\s*module\.storage\.bucket_arn/);
  assert.match(main, /queue_arn\s*=\s*module\.messaging\.queue_arn/);
  for (const module of ['storage', 'messaging', 'job-state', 'identity', 'observability']) {
    const moduleRoot = new URL(`starter/modules/${module}/`, root);
    assert.ok(existsSync(new URL('variables.tf', moduleRoot)) || existsSync(new URL('outputs.tf', moduleRoot)));
  }
});

test('ships a declarative resource-address move and compatibility template', () => {
  const moved = read('starter/moved.tf');
  assert.match(moved, /from\s*=\s*module\.queue\.aws_sqs_queue\.jobs/);
  assert.match(moved, /to\s*=\s*module\.messaging\.aws_sqs_queue\.jobs/);
  assert.ok(existsSync(new URL('compatibility-record.md', root)));
});

test('reports exactly the three intentional starter findings', () => {
  const result = spawnSync(process.execPath, ['section-7/scripts/check-foundation.mjs'], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REJECTED \(3 findings\)/);
  assert.match(result.stdout, /provider\.constraint/);
  assert.match(result.stdout, /output\.sensitivity/);
  assert.match(result.stdout, /identity\.scope/);
});

test('provides a fixed local lifecycle and guarded cleanup', () => {
  const lifecycle = read('scripts/run-local-lifecycle.mjs');
  const cleanup = read('scripts/cleanup-local-run.mjs');
  assert.match(lifecycle, /engine must be terraform or tofu/);
  assert.match(lifecycle, /endpoint must be the approved local Floci endpoint/);
  assert.match(lifecycle, /shell: false/);
  assert.match(lifecycle, /-backend=false/);
  assert.match(lifecycle, /refactor plan did not report the declared move/);
  assert.match(lifecycle, /0 to add, 1 to change, 0 to destroy/);
  assert.match(lifecycle, /human_approval_required: true/);
  assert.ok(!lifecycle.includes("['state', 'mv'"));
  assert.ok(!lifecycle.includes("['import'"));
  assert.match(cleanup, /\.section-7-run/);
  assert.match(cleanup, /lifecycle-evidence\.json/);
  assert.doesNotMatch(cleanup, /rmSync\([^,]+,\s*\{recursive:\s*true,\s*force:\s*true/);
});

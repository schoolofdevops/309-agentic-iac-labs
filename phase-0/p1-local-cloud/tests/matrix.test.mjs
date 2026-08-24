import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('defines the exact P1 local-cloud resource matrix', () => {
  assert.ok(
    existsSync(new URL('../MATRIX.md', import.meta.url)),
    'P1 must define its exact resource and API matrix before Terraform configuration is added',
  );
});

test('requires an explicit Floci-only local mode before resources can be planned', () => {
  const mainPath = new URL('../terraform/main.tf', import.meta.url);
  assert.ok(existsSync(mainPath), 'P1 must provide a Terraform configuration');

  const configuration = readFileSync(mainPath, 'utf8');
  assert.match(configuration, /variable\s+"local_mode"/);
  assert.match(configuration, /variable\s+"local_endpoint"/);
  assert.match(configuration, /check\s+"explicit_local_mode"/);
  assert.match(configuration, /localhost\.floci\.io:4566/);
  assert.match(configuration, /endpoints\s*\{/);
  assert.match(configuration, /variable\s+"queue_visibility_timeout"/);
});

test('models every required local-cloud domain with an isolated P1 prefix', () => {
  const mainPath = new URL('../terraform/main.tf', import.meta.url);
  assert.ok(existsSync(mainPath), 'P1 must provide a Terraform configuration');

  const configuration = readFileSync(mainPath, 'utf8');
  for (const resource of [
    'aws_s3_bucket',
    'aws_s3_bucket_versioning',
    'aws_s3_bucket_public_access_block',
    'aws_sqs_queue',
    'aws_dynamodb_table',
    'aws_iam_role',
    'aws_iam_role_policy',
    'aws_cloudwatch_log_group',
  ]) {
    assert.match(configuration, new RegExp(`resource\\s+"${resource}"`));
  }
  assert.match(configuration, /p1-agentic-iac/);
});

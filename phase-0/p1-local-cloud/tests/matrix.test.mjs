import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

test('defines the exact P1 local-cloud resource matrix', () => {
  assert.ok(
    existsSync(new URL('../MATRIX.md', import.meta.url)),
    'P1 must define its exact resource and API matrix before Terraform configuration is added',
  );
});

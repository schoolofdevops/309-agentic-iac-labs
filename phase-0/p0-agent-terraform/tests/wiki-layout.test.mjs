import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../context/', import.meta.url);

test('provides Karpathy-style source, wiki, schema, index, and log layers', () => {
  for (const path of [
    'raw/',
    'wiki/',
    'AGENTS.md',
    'wiki/index.md',
    'wiki/log.md',
  ]) {
    assert.ok(
      existsSync(new URL(path, root)),
      `P0 context layer is missing ${path}`,
    );
  }
});

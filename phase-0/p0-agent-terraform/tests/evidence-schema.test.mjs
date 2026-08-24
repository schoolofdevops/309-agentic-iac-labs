import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('provides an evidence-record schema for the P0 governed change loop', () => {
  assert.ok(
    existsSync(new URL('../evidence/schema.json', import.meta.url)),
    'P0 must define an evidence-record schema before agents can publish evidence',
  );
});

test('accepts a source-linked task record', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/validate-evidence.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        id: 'p0-task-001',
        kind: 'task',
        source: 'phase-0/p0-agent-terraform/README.md',
        authoring_run: 'p0-local',
        version: '1',
        relations: [
          {
            predicate: 'SUPPORTS',
            target: 'p0-task-001',
            source: 'phase-0/p0-agent-terraform/README.md'
          }
        ]
      }),
    },
  );

  assert.equal(result.status, 0, result.stderr);
});

test('provides a reproducible Terraform defect for a governed repair task', () => {
  const fixture = fileURLToPath(new URL('../fixtures/broken-module', import.meta.url));
  const init = spawnSync('terraform', ['init', '-backend=false', '-input=false'], {
    cwd: fixture,
    encoding: 'utf8',
  });
  const validate = spawnSync('terraform', ['validate', '-no-color'], {
    cwd: fixture,
    encoding: 'utf8',
  });

  assert.equal(init.status, 0, init.stderr);
  assert.notEqual(validate.status, 0, 'the P0 fixture must begin broken');
  assert.match(
    validate.stdout + validate.stderr,
    /Reference to undeclared resource/,
  );
});

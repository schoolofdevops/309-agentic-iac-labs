import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(new URL('../../', import.meta.url).pathname);
const lifecycle = ['section-7/scripts/run-local-lifecycle.mjs'];
const run = (args) => spawnSync(process.execPath, [...lifecycle, ...args], {cwd: repo, encoding: 'utf8'});

test('rejects an unsupported lifecycle engine before creating output', () => {
  const result = run(['--engine', 'pulumi', '--output', '/tmp/s7-invalid-engine']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /engine must be terraform or tofu/);
});

test('rejects a non-Floci endpoint before creating output', () => {
  const result = run(['--engine', 'terraform', '--output', '/tmp/s7-invalid-endpoint', '--endpoint', 'https://aws.amazon.com']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /approved local Floci endpoint/);
});

test('rejects a source outside Section 7', () => {
  const result = run(['--engine', 'terraform', '--source', 'section-6', '--output', '/tmp/s7-invalid-source']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source must stay below section-7/);
});

test('rejects a pre-existing output directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 's7-existing-'));
  try {
    const result = run(['--engine', 'terraform', '--output', root]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must not already exist/);
  } finally {
    rmSync(root, {recursive: true});
  }
});

test('cleanup rejects an unmarked directory and a symbolic link', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 's7-cleanup-test-'));
  const target = path.join(root, 's7-unmarked');
  const link = path.join(root, 's7-link');
  mkdirSync(target);
  writeFileSync(path.join(target, 'lifecycle-evidence.json'), '{}\n');
  symlinkSync(target, link);
  try {
    for (const candidate of [target, link]) {
      const result = spawnSync(process.execPath, ['section-7/scripts/cleanup-local-run.mjs', candidate], {cwd: repo, encoding: 'utf8'});
      assert.equal(result.status, 2);
      assert.match(result.stderr, /REJECTED/);
    }
  } finally {
    rmSync(root, {recursive: true});
  }
});

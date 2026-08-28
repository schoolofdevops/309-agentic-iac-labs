#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';

const authorRoot = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(import.meta.dirname, 'protected-manifest.json');
const scopePath = resolve(import.meta.dirname, 'evaluator-scope.json');
const EXPECTED_SCOPE_SHA256 = '641e684604e6062e45ab9bf3a73b1c9603d24644f7ae8a4ff59a94da76fbe03b';
const PROTECTED_TARGETS = Object.freeze([
  'labs/m9/evaluator-scope.json',
  'section-9/README.md',
  'section-9/challenge/README.md',
  'section-9/request.md',
  'section-9/scripts/check-package.mjs',
  'section-9/scripts/cleanup-kind.mjs',
  'section-9/task.md',
  'section-9/tests/chart-contract.test.mjs',
  'section-9/tests/lifecycle-negative-paths.test.mjs',
  'section-9/tests/workload-contract.test.mjs',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function regularFile(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`protected ${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`protected ${label} must be a regular file`);
  return readFile(path);
}

function targetPath(target, source) {
  if (target.startsWith('section-9/')) return resolve(source, target.slice('section-9/'.length));
  if (target.startsWith('labs/m9/')) return resolve(authorRoot, target);
  throw new Error(`protected manifest target is outside the fixed author scope: ${target}`);
}

async function main() {
  if (process.argv.length !== 4) throw new Error('provide exactly the Section 9 source and one evidence output directory');
  const sourceArgument = process.argv[2];
  const output = resolve(process.argv[3]);
  const source = resolve(sourceArgument);
  if (basename(source) !== 'section-9') throw new Error('source must be a Section 9 directory named section-9');
  const sourceStat = await lstat(sourceArgument);
  if (sourceStat.isSymbolicLink()) throw new Error('symbolic links are not accepted for the Section 9 source');
  if (!sourceStat.isDirectory()) throw new Error('source must be a Section 9 directory');

  const manifestBytes = await regularFile(manifestPath, 'manifest');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 'agentic-iac-section-9-protected-manifest/v1') throw new Error('protected manifest schema changed');
  const targets = Object.keys(manifest.protected_files || {}).sort();
  if (JSON.stringify(targets) !== JSON.stringify([...PROTECTED_TARGETS].sort())) {
    throw new Error('protected manifest target set changed');
  }

  const scopeBytes = await regularFile(scopePath, 'scope');
  const scopeSha256 = sha256(scopeBytes);
  if (scopeSha256 !== EXPECTED_SCOPE_SHA256) throw new Error('protected scope hash mismatch');

  for (const target of PROTECTED_TARGETS) {
    const bytes = target === 'labs/m9/evaluator-scope.json'
      ? scopeBytes
      : await regularFile(targetPath(target, source), `file ${target}`);
    if (sha256(bytes) !== manifest.protected_files[target]) {
      throw new Error(`protected file hash mismatch: ${target}`);
    }
  }

  const evaluator = resolve(source, 'scripts/check-package.mjs');
  const result = spawnSync(process.execPath, [evaluator, source, output], {
    encoding: 'utf8',
    shell: false,
    timeout: 180_000,
    env: {
      ...process.env,
      S9_TRUSTED_LAUNCHER: 'labs/m9/check-section-9.mjs',
      S9_TRUSTED_MANIFEST_SHA256: sha256(manifestBytes),
      S9_TRUSTED_SCOPE_PATH: scopePath,
      S9_TRUSTED_SCOPE_SHA256: scopeSha256,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
});

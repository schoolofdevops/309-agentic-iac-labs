#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {lstat, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';

const EXACT = Object.freeze({
  schema: 'agentic-iac-section-9-kind-run/v1',
  cluster: 'agentic-iac-s9',
  namespace: 'inference',
  release: 'inference-platform',
});

async function main() {
  if (process.argv.length !== 3) throw new Error('provide exactly one marked Section 9 run file');
  const markerArgument = process.argv[2];
  const marker = resolve(markerArgument);
  if (basename(marker) !== '.section-9-kind-run.json') throw new Error('marker must be named .section-9-kind-run.json');

  const markerStat = await lstat(marker);
  if (markerStat.isSymbolicLink()) throw new Error('symbolic links are not accepted for cleanup');
  if (!markerStat.isFile()) throw new Error('cleanup marker must be a regular file');
  const runDirectory = dirname(marker);
  const runStat = await lstat(runDirectory);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) throw new Error('cleanup directory must be a real directory, not symbolic links');
  if (!basename(runDirectory).startsWith('agentic-iac-section-9-')) throw new Error('cleanup directory must use the Section 9 prefix');

  const temporaryRoot = await realpath(tmpdir());
  const realRunDirectory = await realpath(runDirectory);
  const pathBelowTemporaryRoot = relative(temporaryRoot, realRunDirectory);
  if (pathBelowTemporaryRoot === '' || pathBelowTemporaryRoot.startsWith('..') || isAbsolute(pathBelowTemporaryRoot)) {
    throw new Error('cleanup marker must be below the operating system temporary directory');
  }

  const record = JSON.parse(await readFile(marker, 'utf8'));
  if (record.schema !== EXACT.schema
    || record.cluster !== EXACT.cluster
    || record.namespace !== EXACT.namespace
    || record.release !== EXACT.release
    || record.cleanup_allowed !== true) {
    throw new Error('cleanup marker does not contain the exact Section 9 runtime names');
  }
  if (record.cleanup_status === 'COMPLETE') throw new Error('cleanup is already marked complete');

  const result = spawnSync('kind', ['delete', 'cluster', '--name', EXACT.cluster], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') throw new Error('required tool kind is unavailable');
  if (result.status !== 0) throw new Error(`Kind cleanup failed with exit ${result.status ?? 127}`);

  record.cleanup_status = 'COMPLETE';
  record.cleanup_completed_at = new Date().toISOString();
  record.cleanup_command = ['kind', 'delete', 'cluster', '--name', EXACT.cluster];
  await writeFile(marker, `${JSON.stringify(record, null, 2)}\n`, {flag: 'w'});
  console.log(`Cleanup complete for exact cluster ${EXACT.cluster}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
});

#!/usr/bin/env node
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const section = path.resolve(import.meta.dirname, '..');
const engine = process.argv[2] ?? 'terraform';
if (!['terraform', 'tofu'].includes(engine)) {
  console.error('Use: node section-6/scripts/check-harness.mjs [terraform|tofu]');
  process.exit(2);
}

const output = mkdtempSync(path.join(tmpdir(), 'm6-harness-check-'));
const childEnvironment = {
  PATH: process.env.PATH ?? '',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};

try {
  const workflow = spawnSync(
    process.execPath,
    ['starter/harness/run-workflow.mjs', '--engine', engine, '--output', output],
    {cwd: section, encoding: 'utf8', env: childEnvironment},
  );
  process.stdout.write(workflow.stdout);
  process.stderr.write(workflow.stderr);
  if (workflow.status !== 0) process.exitCode = workflow.status ?? 2;
  else {
    const evaluation = spawnSync(
      process.execPath,
      [
        'starter/harness/evaluate-run.mjs',
        '--run', output,
        '--suite', 'tests/complete-suite.json',
      ],
      {cwd: section, encoding: 'utf8', env: childEnvironment},
    );
    process.stdout.write(evaluation.stdout);
    process.stderr.write(evaluation.stderr);
    process.exitCode = evaluation.status ?? 2;
  }
} finally {
  rmSync(output, {recursive: true, force: true});
}

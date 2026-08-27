#!/usr/bin/env node
import {existsSync, lstatSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

try {
  const requested = process.argv[2];
  if (!requested || !path.isAbsolute(requested)) {
    throw new Error('Use an absolute Section 6 run path.');
  }
  if (!path.basename(requested).startsWith('agentic-iac-section-6-')) {
    throw new Error('Refusing a directory without the agentic-iac-section-6- prefix.');
  }
  if (!existsSync(requested)) {
    console.log(`Already absent: ${requested}`);
    process.exit(0);
  }
  if (lstatSync(requested).isSymbolicLink()) {
    throw new Error('Refusing to follow a symbolic link.');
  }
  const resolved = realpathSync(requested);
  const allowedRoots = [...new Set([realpathSync(tmpdir()), realpathSync('/tmp')])];
  if (!allowedRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error('Refusing a directory outside the operating-system temporary roots.');
  }
  const run = JSON.parse(readFileSync(path.join(resolved, 'run.json'), 'utf8'));
  if (run.schema_version !== 1 || !['terraform', 'tofu'].includes(run.engine)) {
    throw new Error('Refusing a directory without a valid Section 6 run record.');
  }
  rmSync(resolved, {recursive: true});
  console.log(`Removed Section 6 run: ${requested}`);
} catch (error) {
  console.error(`Run cleanup: ERROR\n${error.message}`);
  process.exitCode = 2;
}

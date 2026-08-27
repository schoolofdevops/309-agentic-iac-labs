#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const requested = process.argv[2];
if (!requested) {
  console.error('Usage: node section-7/scripts/cleanup-local-run.mjs /tmp/s7-run-name');
  process.exit(2);
}
const target = path.resolve(requested);
const roots = ['/tmp/', '/private/tmp/', `${os.tmpdir().replace(/\/$/, '')}/`];
if (!roots.some((root) => target.startsWith(root)) || !path.basename(target).startsWith('s7-')) {
  console.error('REJECTED: cleanup accepts only a named s7- directory below a temporary root.');
  process.exit(2);
}
if (fs.lstatSync(target).isSymbolicLink() || !fs.existsSync(path.join(target, '.section-7-run')) || !fs.existsSync(path.join(target, 'lifecycle-evidence.json'))) {
  console.error('REJECTED: target is not a completed Section 7 lifecycle record.');
  process.exit(2);
}
fs.rmSync(target, {recursive: true});
console.log(`Removed Section 7 run: ${target}`);

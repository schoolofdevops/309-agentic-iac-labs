#!/usr/bin/env node
import {lstat, readFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';

const requested = process.argv[2];
if (!requested) throw new Error('provide the named Section 8 output directory');
const target = resolve(requested);
if (!target.split('/').at(-1).startsWith('agentic-iac-section-8-')) throw new Error('target is not a Section 8 run');
const details = await lstat(target);
if (details.isSymbolicLink()) throw new Error('symbolic links are not cleanup targets');
const marker = JSON.parse(await readFile(resolve(target, '.section-8-run.json'), 'utf8'));
if (marker.kind !== 'agentic-iac-section-8') throw new Error('invalid marker');
await rm(target, {recursive: true, force: false});
console.log(`Removed Section 8 run: ${target}`);

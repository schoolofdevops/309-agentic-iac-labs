#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const requested = process.argv[2] || 'section-7/starter';
const root = path.resolve(process.cwd(), requested);
const allowedRoot = path.resolve(process.cwd(), 'section-7');
if (root !== allowedRoot && !root.startsWith(`${allowedRoot}${path.sep}`)) {
  console.error('REJECTED: the foundation path must stay below section-7.');
  process.exit(2);
}

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const versions = read('versions.tf');
const outputs = read('outputs.tf');
const identity = read('modules/identity/main.tf');
const findings = [];

if (/version\s*=\s*">= 6\.0\.0"/.test(versions)) {
  findings.push('provider.constraint: Replace the open-ended AWS provider range with the reviewed compatible constraint.');
}
if (/output\s+"local_endpoint"[\s\S]*?\n}/.test(outputs) && !/output\s+"local_endpoint"[\s\S]*?sensitive\s*=\s*true[\s\S]*?\n}/.test(outputs)) {
  findings.push('output.sensitivity: Mark the local endpoint output as sensitive.');
}
if (/Action\s*=\s*"\*"/.test(identity) || /Resource\s*=\s*"\*"/.test(identity)) {
  findings.push('identity.scope: Replace wildcard worker access with exact S3 object and SQS permissions.');
}

if (findings.length) {
  console.log(`Foundation contract: REJECTED (${findings.length} findings)`);
  for (const finding of findings) console.log(`- ${finding}`);
  process.exit(1);
}

for (const required of [
  'version = "~> 6.61.0"',
  'sensitive   = true',
  's3:GetObject',
  's3:PutObject',
  'sqs:ReceiveMessage',
  'sqs:DeleteMessage',
  'sqs:SendMessage',
]) {
  if (!`${versions}\n${outputs}\n${identity}`.includes(required)) {
    console.error(`Foundation contract: REJECTED (missing ${required})`);
    process.exit(1);
  }
}
console.log('Foundation contract: PASS');
console.log('Provider constraint: ~> 6.61.0');
console.log('Sensitive endpoint output: yes');
console.log('Worker policy: exact S3 object and SQS permissions');
console.log('Next decision: local lifecycle requires separate human approval');

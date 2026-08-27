#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const engine = args.get('--engine');
const source = path.resolve(args.get('--source') || 'section-7/starter');
const output = path.resolve(args.get('--output') || '');
const endpoint = args.get('--endpoint') || 'http://localhost.floci.io:4566';
const prefix = args.get('--prefix') || `s7-proof-${Date.now()}`;
const allowedSource = path.resolve('section-7');
const allowedTempRoots = ['/tmp/', '/private/tmp/', `${os.tmpdir().replace(/\/$/, '')}/`];

const reject = (message) => {
  console.error(`REJECTED: ${message}`);
  process.exit(2);
};
if (!['terraform', 'tofu'].includes(engine)) reject('engine must be terraform or tofu');
if (!source.startsWith(`${allowedSource}${path.sep}`)) reject('source must stay below section-7');
if (!output || !allowedTempRoots.some((root) => output.startsWith(root))) reject('output must be a named temporary path');
if (fs.existsSync(output)) reject('output path must not already exist');
if (!['http://localhost:4566', 'http://localhost.floci.io:4566'].includes(endpoint)) reject('endpoint must be the approved local Floci endpoint');
if (!/^s7-[a-z0-9-]+$/.test(prefix)) reject('prefix must begin with s7- and use lowercase letters, numbers, or hyphens');

fs.mkdirSync(output, {recursive: false});
fs.writeFileSync(path.join(output, '.section-7-run'), `${engine}\n${prefix}\n`);
const workspace = path.join(output, 'workspace');
fs.cpSync(source, workspace, {recursive: true});
const finalMain = fs.readFileSync(path.join(workspace, 'main.tf'), 'utf8');
const finalMoved = fs.readFileSync(path.join(workspace, 'moved.tf'), 'utf8');
const finalOutputs = fs.readFileSync(path.join(workspace, 'outputs.tf'), 'utf8');
fs.copyFileSync(path.resolve('section-7/refactor-before/main.tf'), path.join(workspace, 'main.tf'));
fs.copyFileSync(path.resolve('section-7/refactor-before/outputs.tf'), path.join(workspace, 'outputs.tf'));
fs.rmSync(path.join(workspace, 'moved.tf'));

const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  TF_IN_AUTOMATION: '1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_DEFAULT_REGION: 'us-east-1',
};
const events = [];
const run = (label, command, commandArgs, options = {}) => {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || workspace,
    env: childEnv,
    encoding: 'utf8',
    timeout: options.timeout || 180000,
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  events.push({label, argv: [command, ...commandArgs], exit: result.status, duration_ms: Date.now() - started});
  if (result.error || result.status !== 0) {
    fs.writeFileSync(path.join(output, 'failure.log'), `${result.stdout || ''}\n${result.stderr || ''}`);
    console.error(`${label}: FAIL`);
    console.error((result.stderr || result.stdout || result.error?.message || '').trim());
    process.exit(1);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
};
const common = [`-var=local_mode=true`, `-var=local_endpoint=${endpoint}`, `-var=prefix=${prefix}`];
const updated = [...common, '-var=queue_visibility_timeout=45'];

run('init', engine, ['init', '-backend=false', '-input=false', '-no-color']);
run('validate', engine, ['validate', '-no-color']);
const lock = fs.readFileSync(path.join(workspace, '.terraform.lock.hcl'), 'utf8');
const lockSource = lock.includes('registry.opentofu.org/hashicorp/aws') ? 'registry.opentofu.org/hashicorp/aws' : 'registry.terraform.io/hashicorp/aws';
const lockSha256 = crypto.createHash('sha256').update(lock).digest('hex');

run('create-plan', engine, ['plan', '-input=false', '-no-color', '-out=create.tfplan', ...common]);
run('create-apply', engine, ['apply', '-input=false', '-no-color', '-auto-approve', 'create.tfplan']);
const initialState = run('initial-state', engine, ['state', 'list', '-no-color']).trim().split('\n').filter(Boolean);

fs.writeFileSync(path.join(workspace, 'main.tf'), finalMain);
fs.writeFileSync(path.join(workspace, 'moved.tf'), finalMoved);
fs.writeFileSync(path.join(workspace, 'outputs.tf'), finalOutputs);
const refactorPlan = run('refactor-plan', engine, ['plan', '-input=false', '-no-color', '-out=refactor.tfplan', ...common]);
if (!refactorPlan.includes('has moved to')) reject('refactor plan did not report the declared move');
run('refactor-apply', engine, ['apply', '-input=false', '-no-color', '-auto-approve', 'refactor.tfplan']);
const movedState = run('moved-state', engine, ['state', 'list', '-no-color']).trim().split('\n').filter(Boolean);

const updatePlan = run('update-plan', engine, ['plan', '-input=false', '-no-color', '-out=update.tfplan', ...updated]);
if (!/0 to add, 1 to change, 0 to destroy/.test(updatePlan)) reject('queue update was not exactly one in-place change');
run('update-apply', engine, ['apply', '-input=false', '-no-color', '-auto-approve', 'update.tfplan']);
const noChange = run('convergence-plan', engine, ['plan', '-input=false', '-no-color', '-detailed-exitcode', ...updated]);
if (!noChange.includes('No changes.')) reject('second plan did not converge');

const aws = (label, serviceArgs) => run(label, 'aws', [...serviceArgs, '--endpoint-url', endpoint, '--no-cli-pager']);
const api = {
  buckets: JSON.parse(aws('read-s3', ['s3api', 'list-buckets', '--output', 'json'])).Buckets.map((item) => item.Name).filter((name) => name.startsWith(prefix)),
  queues: JSON.parse(aws('read-sqs', ['sqs', 'list-queues', '--queue-name-prefix', prefix, '--output', 'json'])).QueueUrls || [],
  tables: JSON.parse(aws('read-dynamodb', ['dynamodb', 'list-tables', '--output', 'json'])).TableNames.filter((name) => name.startsWith(prefix)),
  roles: JSON.parse(aws('read-iam', ['iam', 'list-roles', '--output', 'json'])).Roles.map((item) => item.RoleName).filter((name) => name.startsWith(prefix)),
  logs: JSON.parse(aws('read-logs', ['logs', 'describe-log-groups', '--log-group-name-prefix', `/course/${prefix}`, '--output', 'json'])).logGroups.map((item) => item.logGroupName),
};

run('destroy', engine, ['destroy', '-input=false', '-no-color', '-auto-approve', ...updated], {timeout: 300000});
const emptyState = run('empty-state', engine, ['state', 'list', '-no-color']).trim();
if (emptyState) reject('state is not empty after destroy');
const destroyCheck = run('destroy-check', engine, ['plan', '-destroy', '-input=false', '-no-color', ...updated]);
if (!destroyCheck.includes('No changes.')) reject('destroy convergence did not report no changes');

const evidence = {
  schema_version: 1,
  engine,
  endpoint,
  prefix,
  provider_version: '6.61.0',
  lock_source: lockSource,
  lock_sha256: lockSha256,
  initial_resource_count: initialState.length,
  moved_from: 'module.queue.aws_sqs_queue.jobs',
  moved_to: 'module.messaging.aws_sqs_queue.jobs',
  moved_resource_count: movedState.length,
  update_summary: '0 add, 1 change, 0 destroy',
  convergence: 'no changes',
  api_observations: api,
  final_state_count: 0,
  destroy_convergence: 'no changes',
  human_approval_required: true,
  events,
};
fs.writeFileSync(path.join(output, 'lifecycle-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

for (const entry of fs.readdirSync(workspace)) fs.rmSync(path.join(workspace, entry), {recursive: true, force: true});
fs.rmdirSync(workspace);
console.log(`Section 7 lifecycle: PASS (${engine})`);
console.log(`Resources: ${initialState.length} created, 1 moved, 1 changed in place, ${evidence.final_state_count} remain`);
console.log(`Lock source: ${lockSource}`);
console.log(`Evidence: ${path.join(output, 'lifecycle-evidence.json')}`);
console.log('Decision: ready for human review; no production action approved');

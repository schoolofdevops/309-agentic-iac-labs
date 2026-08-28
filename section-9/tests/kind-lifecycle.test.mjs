import assert from 'node:assert/strict';
import {access, chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const section = resolve(import.meta.dirname, '..');
const runner = resolve(section, 'scripts/run-kind-lifecycle.mjs');
const clusterConfig = resolve(section, 'tools/kind/cluster.yaml');

function run(args, options = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
}

async function fakeRuntime(testContext, {clusters = '', architecture = 'arm64'} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentic-iac-section-9-test-'));
  testContext.after(async () => rm(root, {recursive: true, force: true}));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.jsonl');
  await mkdir(bin);
  const docker = join(bin, 'docker');
  const kind = join(bin, 'kind');
  await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' '{"command":"docker","argv":"'"$*"'"}' >> "$S9_TEST_COMMAND_LOG"\nif [ "$1" = "info" ]; then printf '%s\\n' '5\\t8313110528\\t${architecture}\\t28.3.3'; exit 0; fi\nexit 0\n`);
  await writeFile(kind, `#!/bin/sh\nprintf '%s\\n' '{"command":"kind","argv":"'"$*"'"}' >> "$S9_TEST_COMMAND_LOG"\nif [ "$1 $2" = "get clusters" ]; then printf '%s' '${clusters}'; exit 0; fi\nexit 0\n`);
  await chmod(docker, 0o755);
  await chmod(kind, 0o755);
  return {
    root,
    log,
    env: {...process.env, PATH: `${bin}:${process.env.PATH}`, S9_TEST_COMMAND_LOG: log},
  };
}

test('Kind config maps the API only to loopback port 18080', async () => {
  const config = await readFile(clusterConfig, 'utf8');
  assert.match(config, /^kind: Cluster$/m);
  assert.match(config, /containerPort: 30080\n\s+hostPort: 18080\n\s+listenAddress: "127\.0\.0\.1"/);
  assert.doesNotMatch(config, /0\.0\.0\.0/);
});

test('runner discovers the actual named Kind node image instead of assuming a version tag', async () => {
  const source = await readFile(runner, 'utf8');
  assert.match(source, /docker', \['inspect', '--format', '\{\{\.Image\}\}', EXACT\.node\]/);
  assert.match(source, /docker', \['image', 'inspect',[\s\S]*nodeImageReference/);
  assert.doesNotMatch(source, /kindest\/node:v\d/);
});

test('sampler begins before Kind creation and records one pre-create attempt', async () => {
  const source = await readFile(runner, 'utf8');
  const samplerStart = source.indexOf('sampler = startSampler(samplesPath)');
  const firstAttempt = source.indexOf('await waitForSamplerAttempt(samplesPath)');
  const clusterCreate = source.indexOf("execute('kind', ['create', 'cluster'");
  assert.notEqual(samplerStart, -1);
  assert.notEqual(firstAttempt, -1);
  assert.notEqual(clusterCreate, -1);
  assert.ok(samplerStart < firstAttempt, 'sampler must start before its first recorded attempt');
  assert.ok(firstAttempt < clusterCreate, 'one sampler attempt must be recorded before Kind creation');
});

test('sampler continues through exact cluster cleanup before it stops', async () => {
  const source = await readFile(runner, 'utf8');
  const cleanupStart = source.indexOf('async function cleanupRuntime');
  const cleanupEnd = source.indexOf('\nasync function runLifecycle', cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  const clusterDelete = cleanupSource.indexOf('cleanupScript, marker');
  const postDeleteAttempt = cleanupSource.indexOf('await waitForSamplerAttempt(samplesPath,');
  const samplerStop = cleanupSource.indexOf('await stopSampler(sampler)');
  assert.notEqual(clusterDelete, -1);
  assert.notEqual(postDeleteAttempt, -1);
  assert.notEqual(samplerStop, -1);
  assert.ok(clusterDelete < postDeleteAttempt, 'sampler must observe after exact cluster deletion');
  assert.ok(postDeleteAttempt < samplerStop, 'sampler must stop only after the post-delete attempt');
});

test('runtime report separates Docker allocation from named-node memory samples', async () => {
  const source = await readFile(runner, 'utf8');
  assert.match(source, /configured_capacity_not_working_set: true/);
  assert.match(source, /measurement_scope: 'named Kind node container via docker stats'/);
  assert.match(source, /does not measure the Docker Desktop Linux VM working set/);
  assert.doesNotMatch(source, /runtime VM memory is measured/i);
});

test('fake runtime fixtures register recursive cleanup with the owning test', async () => {
  const source = await readFile(import.meta.filename, 'utf8');
  assert.match(source, /async function fakeRuntime\(testContext,[\s\S]{0,800}testContext\.after\(async \(\) => rm\(root, \{recursive: true, force: true\}\)\)/);
});

test('preflight rejects a wrong cluster name before invoking runtime tools', async (testContext) => {
  const runtime = await fakeRuntime(testContext);
  const output = join(runtime.root, 'agentic-iac-section-9-wrong-cluster');
  const result = run(['preflight', section, output, '--cluster', 'kind'], {env: runtime.env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cluster must be exactly agentic-iac-s9/i);
  await assert.rejects(access(runtime.log));
  await assert.rejects(access(output));
});

test('preflight refuses to adopt or delete an existing exact cluster', async (testContext) => {
  const runtime = await fakeRuntime(testContext, {clusters: 'agentic-iac-s9\n'});
  const output = join(runtime.root, 'agentic-iac-section-9-existing-cluster');
  const result = run(['preflight', section, output], {env: runtime.env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists.*refuses to adopt or delete/i);
  const commands = await readFile(runtime.log, 'utf8');
  assert.match(commands, /get clusters/);
  assert.doesNotMatch(commands, /delete cluster/);
  await assert.rejects(access(output));
});

test('preflight rejects a wrong namespace before invoking runtime tools', async (testContext) => {
  const runtime = await fakeRuntime(testContext);
  const output = join(runtime.root, 'agentic-iac-section-9-wrong-namespace');
  const result = run(['preflight', section, output, '--namespace', 'default'], {env: runtime.env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /namespace must be exactly inference/i);
  await assert.rejects(access(runtime.log));
  await assert.rejects(access(output));
});

test('cleanup rejects a missing marker without invoking Kind', async (testContext) => {
  const runtime = await fakeRuntime(testContext);
  const marker = join(runtime.root, 'agentic-iac-section-9-missing', '.section-9-kind-run.json');
  const result = run(['cleanup', marker], {env: runtime.env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cleanup marker.*does not exist/i);
  await assert.rejects(access(runtime.log));
});

test('preflight rejects an unsupported Docker architecture', async (testContext) => {
  const runtime = await fakeRuntime(testContext, {architecture: 'riscv64'});
  const output = join(runtime.root, 'agentic-iac-section-9-unsupported-arch');
  const result = run(['preflight', section, output], {env: runtime.env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported Docker architecture riscv64/i);
  const commands = await readFile(runtime.log, 'utf8');
  assert.match(commands, /docker.*info/);
  assert.doesNotMatch(commands, /kind.*create cluster/);
  await assert.rejects(access(output));
});

test('cleanup refuses an unmarked cluster request and never invokes Kind', async (testContext) => {
  const runtime = await fakeRuntime(testContext);
  const runDirectory = join(runtime.root, 'agentic-iac-section-9-unmarked');
  const marker = join(runDirectory, '.section-9-kind-run.json');
  await mkdir(runDirectory);
  await writeFile(marker, `${JSON.stringify({
    schema: 'agentic-iac-section-9-kind-run/v1',
    cluster: 'agentic-iac-s9',
    namespace: 'inference',
    release: 'inference-platform',
    cleanup_allowed: false,
  })}\n`);

  const result = run(['cleanup', marker], {env: runtime.env});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not marked for exact Section 9 cleanup/i);
  await assert.rejects(access(runtime.log));
});

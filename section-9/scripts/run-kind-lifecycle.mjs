#!/usr/bin/env node
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {appendFile, lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';
import process from 'node:process';

const EXACT = Object.freeze({
  schema: 'agentic-iac-section-9-kind-run/v1',
  cluster: 'agentic-iac-s9',
  context: 'kind-agentic-iac-s9',
  node: 'agentic-iac-s9-control-plane',
  namespace: 'inference',
  release: 'inference-platform',
  secret: 'inference-platform-backend-token',
  image: '309-agentic-iac/inference-platform:s9',
});
const ROLES = Object.freeze(['dependencies', 'api', 'worker']);
const SUPPORTED_ARCHITECTURES = new Map([
  ['amd64', 'amd64'],
  ['x86_64', 'amd64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
]);
const scriptPath = resolve(process.argv[1]);
const cleanupScript = resolve(dirname(scriptPath), 'cleanup-kind.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const elapsedSeconds = (started) => Number(((Date.now() - started) / 1000).toFixed(3));
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function parseOptions(arguments_) {
  const positionals = [];
  const options = {
    cluster: EXACT.cluster,
    namespace: EXACT.namespace,
    release: EXACT.release,
    mode: 'cold',
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!['cluster', 'namespace', 'release', 'mode'].includes(key)) throw new Error(`unknown option ${value}`);
    if (index + 1 >= arguments_.length) throw new Error(`option ${value} requires a value`);
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return {positionals, options};
}

function validateExactNames(options) {
  if (options.cluster !== EXACT.cluster) throw new Error(`cluster must be exactly ${EXACT.cluster}`);
  if (options.namespace !== EXACT.namespace) throw new Error(`namespace must be exactly ${EXACT.namespace}`);
  if (options.release !== EXACT.release) throw new Error(`release must be exactly ${EXACT.release}`);
  if (!['cold', 'warm'].includes(options.mode)) throw new Error('mode must be cold or warm');
}

function execute(command, args, {cwd, input, allowFailure = false, records, redact = false, timeout = 180_000} = {}) {
  const startedAt = now();
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout,
  });
  const exit = result.status ?? (result.error?.code === 'ENOENT' ? 127 : 124);
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (records) {
    records.push({
      argv: redact ? [command, '[REDACTED INPUT VIA STDIN]'] : [command, ...args],
      started_at: startedAt,
      elapsed_seconds: elapsedSeconds(started),
      exit,
      stdout,
      stderr,
    });
  }
  if (!allowFailure && exit !== 0) {
    const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${command} ${args.join(' ')} exited ${exit}${detail ? `: ${detail}` : ''}`);
  }
  return {exit, stdout, stderr};
}

async function regularDirectory(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory, not a symbolic link`);
}

async function validateOutputPath(outputArgument) {
  const output = resolve(outputArgument);
  if (!basename(output).startsWith('agentic-iac-section-9-')) {
    throw new Error('output must use the agentic-iac-section-9- prefix');
  }
  await regularDirectory(dirname(output), 'output parent');
  const temporaryRoot = await realpath(tmpdir());
  const realParent = await realpath(dirname(output));
  const belowTemporaryRoot = relative(temporaryRoot, resolve(realParent, basename(output)));
  if (belowTemporaryRoot === '' || belowTemporaryRoot.startsWith('..') || isAbsolute(belowTemporaryRoot)) {
    throw new Error('output must be below the operating system temporary directory');
  }
  try {
    await lstat(output);
    throw new Error('output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

async function preflight(sourceArgument, outputArgument, options) {
  validateExactNames(options);
  const source = resolve(sourceArgument);
  if (basename(source) !== 'section-9') throw new Error('source must be a directory named section-9');
  await regularDirectory(sourceArgument, 'source');
  const output = await validateOutputPath(outputArgument);

  const dockerInfoResult = execute('docker', ['info', '--format', '{{.NCPU}}\t{{.MemTotal}}\t{{.Architecture}}\t{{.ServerVersion}}']);
  const fields = dockerInfoResult.stdout.trim().replaceAll('\\t', '\t').split('\t');
  if (fields.length !== 4) throw new Error('Docker info did not return CPU, memory, architecture, and version');
  const [cpus, memoryBytes, reportedArchitecture, serverVersion] = fields;
  const architecture = SUPPORTED_ARCHITECTURES.get(reportedArchitecture);
  if (!architecture) throw new Error(`unsupported Docker architecture ${reportedArchitecture}`);

  const clustersResult = execute('kind', ['get', 'clusters']);
  const clusters = clustersResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (clusters.includes(EXACT.cluster)) {
    throw new Error(`cluster ${EXACT.cluster} already exists; the lifecycle refuses to adopt or delete it`);
  }
  return {
    source,
    output,
    architecture,
    docker: {
      cpus: Number(cpus),
      memory_bytes: Number(memoryBytes),
      memory_gib: Number((Number(memoryBytes) / 1024 ** 3).toFixed(3)),
      reported_architecture: reportedArchitecture,
      server_version: serverVersion,
    },
  };
}

async function readMarker(markerArgument) {
  const marker = resolve(markerArgument);
  let stat;
  try {
    stat = await lstat(marker);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('cleanup marker does not exist');
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('cleanup marker must be a regular file, not a symbolic link');
  const record = JSON.parse(await readFile(marker, 'utf8'));
  if (record.schema !== EXACT.schema
    || record.cluster !== EXACT.cluster
    || record.namespace !== EXACT.namespace
    || record.release !== EXACT.release
    || record.cleanup_allowed !== true) {
    throw new Error('cluster request is not marked for exact Section 9 cleanup');
  }
  return {marker, record};
}

async function cleanupCommand(markerArgument) {
  const {marker} = await readMarker(markerArgument);
  execute(process.execPath, [cleanupScript, marker]);
}

function parseMemoryBytes(usage) {
  const value = usage.trim().split('/')[0].trim();
  const match = value.match(/^([0-9.]+)(B|KiB|MiB|GiB)$/);
  if (!match) return null;
  const multipliers = {B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3};
  return Math.round(Number(match[1]) * multipliers[match[2]]);
}

async function sampleNode(output) {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    const sample = execute('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}\t{{.CPUPerc}}', EXACT.node], {allowFailure: true, timeout: 15_000});
    const fields = sample.stdout.trim().split('\t');
    const record = {
      sampled_at: now(),
      exit: sample.exit,
      memory_usage: fields[0] || null,
      memory_bytes: fields[0] ? parseMemoryBytes(fields[0]) : null,
      cpu_percent: fields[1] || null,
    };
    await appendFile(output, `${JSON.stringify(record)}\n`);
    await delay(1_000);
  }
}

function startSampler(output) {
  return spawn(process.execPath, [scriptPath, 'sample', output], {
    stdio: 'ignore',
    shell: false,
  });
}

async function stopSampler(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolveDone) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveDone();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveDone();
    });
    child.kill('SIGTERM');
  });
}

async function readSampleRecords(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForSamplerAttempt(path, previousCount = 0, requireNodeAbsent = false) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const samples = await readSampleRecords(path);
    if (samples.length > previousCount && (!requireNodeAbsent || samples.at(-1).exit !== 0)) return samples.length;
    await delay(100);
  }
  throw new Error(requireNodeAbsent
    ? 'sampler did not record the named Kind node as absent after cleanup'
    : 'sampler did not record an attempt before Kind creation');
}

async function loadSamples(path) {
  const samples = await readSampleRecords(path);
  const valid = samples.filter(({exit, memory_bytes: bytes}) => exit === 0 && Number.isFinite(bytes));
  const peakBytes = valid.reduce((peak, sample) => Math.max(peak, sample.memory_bytes), 0);
  const firstPresentIndex = samples.findIndex(({exit, memory_bytes: bytes}) => exit === 0 && Number.isFinite(bytes));
  let lastPresentIndex = -1;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].exit === 0 && Number.isFinite(samples[index].memory_bytes)) {
      lastPresentIndex = index;
      break;
    }
  }
  const firstAbsentAfterNode = lastPresentIndex === -1
    ? null
    : samples.slice(lastPresentIndex + 1).find(({exit}) => exit !== 0) || null;
  return {
    measurement_scope: 'named Kind node container via docker stats',
    attempt_count: samples.length,
    pre_appearance_attempt_count: firstPresentIndex === -1 ? samples.length : firstPresentIndex,
    sample_count: valid.length,
    peak_memory_bytes: peakBytes,
    peak_memory_mib: Number((peakBytes / 1024 ** 2).toFixed(1)),
    first_node_observed_at: valid[0]?.sampled_at || null,
    last_node_observed_at: valid.at(-1)?.sampled_at || null,
    first_absent_after_node_at: firstAbsentAfterNode?.sampled_at || null,
  };
}

function curl(records, args, allowFailure = false) {
  return execute('curl', args, {records, allowFailure, timeout: 15_000});
}

function parseHTTPResponse(stdout) {
  const marker = '\nHTTP_STATUS:';
  const offset = stdout.lastIndexOf(marker);
  if (offset === -1) throw new Error('HTTP response did not include a status marker');
  return {body: stdout.slice(0, offset).trim(), status: Number(stdout.slice(offset + marker.length).trim())};
}

async function cleanupRuntime({marker, report, sampler, samplesPath, clusterMayExist, namespaceMayExist, releaseMayExist}) {
  const cleanupStarted = Date.now();
  const records = report.cleanup.commands;
  let cleanupError = null;
  try {
    const clusters = execute('kind', ['get', 'clusters'], {records, allowFailure: true});
    const clusterExists = clusters.exit === 0 && clusters.stdout.split(/\r?\n/).includes(EXACT.cluster);
    if (clusterExists && releaseMayExist) {
      execute('helm', ['--kube-context', EXACT.context, '--namespace', EXACT.namespace, 'uninstall', EXACT.release, '--wait', '--timeout', '60s'], {records, allowFailure: true});
      const releases = execute('helm', ['--kube-context', EXACT.context, '--namespace', EXACT.namespace, 'list', '--short'], {records, allowFailure: true});
      report.cleanup.release_absent_before_namespace_delete = releases.exit !== 0 || !releases.stdout.split(/\r?\n/).includes(EXACT.release);
    }
    if (clusterExists && namespaceMayExist) {
      execute('kubectl', ['--context', EXACT.context, 'delete', 'namespace', EXACT.namespace, '--wait=true', '--timeout=60s'], {records, allowFailure: true, timeout: 75_000});
      const namespace = execute('kubectl', ['--context', EXACT.context, 'get', 'namespace', EXACT.namespace], {records, allowFailure: true});
      report.cleanup.namespace_absent_before_cluster_delete = namespace.exit !== 0;
    }
    if (clusterExists || clusterMayExist) {
      const cleaned = execute(process.execPath, [cleanupScript, marker], {records, allowFailure: true, timeout: 120_000});
      if (cleaned.exit !== 0 && clusterExists) throw new Error(`exact Kind cleanup exited ${cleaned.exit}`);
    }
    if (sampler) {
      const attemptsBeforePostDelete = (await readSampleRecords(samplesPath)).length;
      await waitForSamplerAttempt(samplesPath, attemptsBeforePostDelete, true);
    }
  } catch (error) {
    cleanupError = error;
  }
  await stopSampler(sampler);

  const remainingClusters = execute('kind', ['get', 'clusters'], {records, allowFailure: true});
  const remainingContainers = execute('docker', ['ps', '-a', '--filter', `name=${EXACT.node}`, '--format', '{{.Names}}'], {records, allowFailure: true});
  report.cleanup.cluster_absent = remainingClusters.exit === 0 && !remainingClusters.stdout.split(/\r?\n/).includes(EXACT.cluster);
  report.cleanup.section_9_containers_absent = remainingContainers.exit === 0 && !remainingContainers.stdout.trim();
  report.cleanup.elapsed_seconds = elapsedSeconds(cleanupStarted);
  report.cleanup.completed_at = now();
  report.cleanup.status = !cleanupError
    && report.cleanup.cluster_absent
    && report.cleanup.section_9_containers_absent
    && (report.cleanup.namespace_absent_before_cluster_delete ?? true)
    && (report.cleanup.release_absent_before_namespace_delete ?? true)
    ? 'PASS' : 'FAIL';
  if (cleanupError) report.cleanup.error = cleanupError.message;
  return cleanupError;
}

async function runLifecycle(sourceArgument, outputArgument, options) {
  const totalStarted = Date.now();
  const environment = await preflight(sourceArgument, outputArgument, options);
  const {source, output, architecture, docker} = environment;
  const marker = resolve(output, '.section-9-kind-run.json');
  const reportPath = resolve(output, 'runtime-report.json');
  const samplesPath = resolve(output, 'docker-stats.jsonl');
  const records = [];
  const report = {
    schema: 'agentic-iac-section-9-runtime-evidence/v1',
    result: 'IN_PROGRESS',
    mode: options.mode,
    started_at: now(),
    exact_names: EXACT,
    environment: {
      docker: {...docker, configured_capacity_not_working_set: true},
      normalized_architecture: architecture,
    },
    commands: records,
    measurements: {},
    observations: {},
    cleanup: {status: 'PENDING', commands: []},
    proof_limits: [
      'NetworkPolicy is disabled in this Kind profile; no enforcement claim is made.',
      'Named-workload memory is sampled from the Kind node container with docker stats; this does not measure the Docker Desktop Linux VM working set.',
      'Docker CPU and memory allocation are reported separately as configured capacity, not observed working-set usage.',
      'Runtime success is evidence for this exact chart, image, architecture, and run only.',
    ],
  };
  let sampler = null;
  let clusterMayExist = false;
  let namespaceMayExist = false;
  let releaseMayExist = false;
  let failure = null;

  await mkdir(output);
  await writeFile(marker, `${JSON.stringify({
    schema: EXACT.schema,
    cluster: EXACT.cluster,
    namespace: EXACT.namespace,
    release: EXACT.release,
    cleanup_allowed: true,
    mode: options.mode,
    created_at: now(),
    cleanup_status: 'PENDING',
  }, null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  try {
    const versions = {};
    for (const [tool, args] of [
      ['docker', ['version', '--format', '{{.Server.Version}}']],
      ['kind', ['version']],
      ['kubectl', ['version', '--client', '--output=yaml']],
      ['helm', ['version', '--short']],
      ['curl', ['--version']],
    ]) {
      const probe = execute(tool, args, {records, timeout: 30_000});
      versions[tool] = (probe.stdout || probe.stderr).trim().split('\n')[0];
    }
    report.environment.tool_versions = versions;

    const render = execute('helm', ['template', EXACT.release, resolve(source, 'chart'), '--namespace', EXACT.namespace, '--set', 'networkPolicy.enabled=false'], {records});
    report.observations.render = {
      sha256: sha256(render.stdout),
      bytes: Buffer.byteLength(render.stdout),
      network_policy_disabled: !/^kind: NetworkPolicy$/m.test(render.stdout),
    };
    if (!report.observations.render.network_policy_disabled) throw new Error('NetworkPolicy object rendered in the disabled core profile');

    const buildStarted = Date.now();
    execute('docker', ['build', '--platform', `linux/${architecture}`, '--tag', EXACT.image, resolve(source, 'app')], {records, timeout: 300_000});
    report.measurements.image_build_elapsed_seconds = elapsedSeconds(buildStarted);
    const image = execute('docker', ['image', 'inspect', '--format', '{{.Id}}\t{{.Size}}\t{{.Architecture}}', EXACT.image], {records});
    const [imageId, imageSize, imageArchitecture] = image.stdout.trim().split('\t');
    report.measurements.workload_image = {id: imageId, size_bytes: Number(imageSize), architecture: imageArchitecture};

    sampler = startSampler(samplesPath);
    report.measurements.pre_create_sampler_attempt_count = await waitForSamplerAttempt(samplesPath);
    clusterMayExist = true;
    const clusterStarted = Date.now();
    execute('kind', ['create', 'cluster', '--name', EXACT.cluster, '--config', resolve(source, 'tools/kind/cluster.yaml'), '--wait', '120s'], {records, timeout: 180_000});
    report.measurements.cluster_create_elapsed_seconds = elapsedSeconds(clusterStarted);

    const nodeContainer = execute('docker', ['inspect', '--format', '{{.Image}}', EXACT.node], {records});
    const nodeImageReference = nodeContainer.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(nodeImageReference)) throw new Error('named Kind node did not report an immutable image digest');
    const nodeImage = execute('docker', ['image', 'inspect', '--format', '{{.Id}}\t{{.RepoDigests}}\t{{.Size}}\t{{.Architecture}}', nodeImageReference], {records});
    const [id, repositoryDigests, size, arch] = nodeImage.stdout.trim().split('\t');
    report.measurements.kind_node_image = {id, repository_digests: repositoryDigests, size_bytes: Number(size), architecture: arch};

    execute('kind', ['load', 'docker-image', EXACT.image, '--name', EXACT.cluster], {records, timeout: 120_000});
    execute('kubectl', ['--context', EXACT.context, 'create', 'namespace', EXACT.namespace], {records});
    namespaceMayExist = true;
    const disposableToken = `s9-${randomBytes(24).toString('hex')}`;
    const secretManifest = `${JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {name: EXACT.secret, namespace: EXACT.namespace},
      type: 'Opaque',
      stringData: {token: disposableToken},
    })}\n`;
    execute('kubectl', ['--context', EXACT.context, 'apply', '-f', '-'], {records, input: secretManifest, redact: true});

    const installStarted = Date.now();
    execute('helm', ['--kube-context', EXACT.context, '--namespace', EXACT.namespace, 'install', EXACT.release, resolve(source, 'chart'), '--set', 'networkPolicy.enabled=false', '--wait', '--timeout', '120s'], {records, timeout: 150_000});
    releaseMayExist = true;
    report.measurements.helm_install_elapsed_seconds = elapsedSeconds(installStarted);
    for (const role of ROLES) {
      execute('kubectl', ['--context', EXACT.context, '--namespace', EXACT.namespace, 'rollout', 'status', `deployment/${EXACT.release}-${role}`, '--timeout=120s'], {records, timeout: 135_000});
    }

    const verificationStarted = Date.now();
    const health = parseHTTPResponse(curl(records, ['-sS', '-o', '-', '-w', '\nHTTP_STATUS:%{http_code}\n', 'http://127.0.0.1:18080/healthz']).stdout);
    const ready = parseHTTPResponse(curl(records, ['-sS', '-o', '-', '-w', '\nHTTP_STATUS:%{http_code}\n', 'http://127.0.0.1:18080/readyz']).stdout);
    if (health.status !== 200 || ready.status !== 200) throw new Error(`API health/ready status was ${health.status}/${ready.status}`);
    report.observations.http = {health, ready};

    const submitted = parseHTTPResponse(curl(records, ['-sS', '-o', '-', '-w', '\nHTTP_STATUS:%{http_code}\n', '-X', 'POST', '-H', 'Content-Type: application/json', '--data', '{"input":"hello platform"}', 'http://127.0.0.1:18080/jobs']).stdout);
    if (submitted.status !== 202) throw new Error(`job submit status was ${submitted.status}, want 202`);
    const submittedJob = JSON.parse(submitted.body);
    if (submittedJob.job_id !== 'job-0001') throw new Error(`job id was ${submittedJob.job_id}, want job-0001`);
    const transitions = [submittedJob.status];
    let completedJob = submittedJob;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = parseHTTPResponse(curl(records, ['-sS', '-o', '-', '-w', '\nHTTP_STATUS:%{http_code}\n', `http://127.0.0.1:18080/jobs/${submittedJob.job_id}`]).stdout);
      if (observed.status !== 200) throw new Error(`job observation status was ${observed.status}`);
      completedJob = JSON.parse(observed.body);
      if (!transitions.includes(completedJob.status)) transitions.push(completedJob.status);
      if (completedJob.status === 'complete') break;
      if (completedJob.status === 'failed') throw new Error(`job failed: ${completedJob.error}`);
      await delay(50);
    }
    if (completedJob.status !== 'complete') throw new Error('job did not complete within 5 seconds');
    if (completedJob.result !== 'MOCK INFERENCE: HELLO PLATFORM') throw new Error(`unexpected deterministic result ${completedJob.result}`);
    report.observations.job = {submitted: submittedJob, transitions, completed: completedJob};

    const kubectlEvidence = {};
    for (const [id, args] of [
      ['object_inventory', ['get', 'all', '-o', 'wide']],
      ['pods', ['get', 'pods', '-o', 'wide']],
      ['services', ['get', 'services', '-o', 'wide']],
      ['endpoints', ['get', 'endpoints', '-o', 'wide']],
      ['events', ['get', 'events', '--sort-by=.metadata.creationTimestamp', '-o', 'wide']],
    ]) {
      kubectlEvidence[id] = execute('kubectl', ['--context', EXACT.context, '--namespace', EXACT.namespace, ...args], {records}).stdout;
    }
    kubectlEvidence.logs = {};
    for (const role of ROLES) {
      kubectlEvidence.logs[role] = execute('kubectl', ['--context', EXACT.context, '--namespace', EXACT.namespace, 'logs', `deployment/${EXACT.release}-${role}`, '--tail=100'], {records}).stdout;
    }
    report.observations.kubernetes = kubectlEvidence;
    report.measurements.verification_elapsed_seconds = elapsedSeconds(verificationStarted);
    report.result = 'PASS';
  } catch (error) {
    failure = error;
    report.result = 'FAIL';
    report.error = error.message;
  } finally {
    const cleanupError = await cleanupRuntime({
      marker,
      report,
      sampler,
      samplesPath,
      clusterMayExist,
      namespaceMayExist,
      releaseMayExist,
    });
    report.measurements.node = await loadSamples(samplesPath);
    report.measurements.total_elapsed_seconds = elapsedSeconds(totalStarted);
    report.completed_at = now();
    if (sampler && (report.measurements.pre_create_sampler_attempt_count < 1
      || !report.measurements.node.first_node_observed_at
      || !report.measurements.node.first_absent_after_node_at)) {
      report.result = 'FAIL';
      report.error = report.error || 'sampler did not cover pre-create through post-cleanup node lifetime';
    }
    if (cleanupError || report.cleanup.status !== 'PASS') {
      report.result = 'FAIL';
      report.error = report.error || cleanupError?.message || 'cleanup verification failed';
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure || report.result !== 'PASS') throw new Error(report.error || failure?.message || 'lifecycle failed');
  console.log(`Section 9 ${options.mode} lifecycle: PASS`);
  console.log(`Evidence: ${reportPath}`);
  console.log(`Peak Kind node memory: ${report.measurements.node.peak_memory_mib} MiB`);
  console.log(`Total elapsed: ${report.measurements.total_elapsed_seconds} seconds`);
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'sample') {
    if (arguments_.length !== 1) throw new Error('sample requires exactly one output file');
    await sampleNode(resolve(arguments_[0]));
    return;
  }
  if (command === 'cleanup') {
    if (arguments_.length !== 1) throw new Error('cleanup requires exactly one marker');
    await cleanupCommand(arguments_[0]);
    return;
  }
  const {positionals, options} = parseOptions(arguments_);
  if (!['preflight', 'run'].includes(command)) throw new Error('command must be preflight, run, or cleanup');
  if (positionals.length !== 2) throw new Error(`${command} requires the Section 9 source and one new output directory`);
  if (command === 'preflight') {
    const result = await preflight(positionals[0], positionals[1], options);
    console.log(JSON.stringify({
      result: 'PASS',
      cluster: EXACT.cluster,
      namespace: EXACT.namespace,
      architecture: result.architecture,
      docker: result.docker,
    }));
    return;
  }
  await runLifecycle(positionals[0], positionals[1], options);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
});

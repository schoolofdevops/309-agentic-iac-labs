#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';

const CHECK_RESOURCE_LIMITS = true;
const CHECK_SECRET_MATERIAL = true;
const RUN_SCHEMA_CHECKS = true;

const EVALUATED_FILES = Object.freeze([
  'app/.dockerignore',
  'app/Dockerfile',
  'app/api.go',
  'app/backend.go',
  'app/go.mod',
  'app/main.go',
  'app/main_test.go',
  'app/worker.go',
  'chart/Chart.yaml',
  'chart/templates/_helpers.tpl',
  'chart/templates/configmap.yaml',
  'chart/templates/deployment.yaml',
  'chart/templates/networkpolicy.yaml',
  'chart/templates/service.yaml',
  'chart/templates/serviceaccount.yaml',
  'chart/values.schema.json',
  'chart/values.yaml',
  'policy/workload.rego',
]);
const LEARNER_OWNED_FILES = Object.freeze([
  'chart/templates/deployment.yaml',
  'chart/values.schema.json',
  'chart/values.yaml',
]);
const READ_ONLY_FILES = Object.freeze(EVALUATED_FILES.filter((file) => !LEARNER_OWNED_FILES.includes(file)));
const EXPECTED_READ_ONLY_SHA256 = '940959a436aa01fcfc78f10d8d6b0225f4efa1896aa1367f12a49a3d6dcd01e5';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const status = (pass, detail) => ({status: pass ? 'PASS' : 'FAIL', detail});
let createdOutput = null;

async function filesBelow(directory, prefix) {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = resolve(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    const entryStat = await lstat(absolute);
    if (entryStat.isSymbolicLink()) throw new Error(`symbolic links are not accepted in evaluated scope: ${relativePath}`);
    if (entryStat.isDirectory()) files.push(...await filesBelow(absolute, relativePath));
    else if (entryStat.isFile()) files.push(relativePath);
    else throw new Error(`evaluated scope contains a non-regular file: ${relativePath}`);
  }
  return files;
}

async function scopedHash(source, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(resolve(source, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function toolProbe(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', shell: false, timeout: 30_000});
  if (result.error?.code === 'ENOENT') throw new Error(`required tool ${command} is unavailable`);
  if (result.status !== 0) throw new Error(`required tool ${command} probe exited ${result.status ?? 127}`);
}

function collectMessages(value, messages = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectMessages(child, messages);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'msg' || key === 'message') && typeof child === 'string') messages.push(child);
      else collectMessages(child, messages);
    }
  }
  return messages;
}

async function main() {
  if (process.argv.length !== 4) throw new Error('provide exactly the Section 9 source and one evidence output directory');
  const sourceArgument = process.argv[2];
  const outputArgument = process.argv[3];
  const source = resolve(sourceArgument);
  const output = resolve(outputArgument);

  if (basename(source) !== 'section-9') throw new Error('source must be a Section 9 directory named section-9');
  const sourceStat = await lstat(sourceArgument);
  if (sourceStat.isSymbolicLink()) throw new Error('symbolic links are not accepted for the Section 9 source');
  if (!sourceStat.isDirectory()) throw new Error('source must be a Section 9 directory');

  const actualFiles = [
    ...await filesBelow(resolve(source, 'app'), 'app'),
    ...await filesBelow(resolve(source, 'chart'), 'chart'),
    ...await filesBelow(resolve(source, 'policy'), 'policy'),
  ].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...EVALUATED_FILES].sort())) {
    throw new Error('evaluated source scope changed: expected the fixed app, chart, and policy files');
  }

  if (!basename(output).startsWith('agentic-iac-section-9-')) throw new Error('output must use the agentic-iac-section-9- prefix');
  const outputParent = dirname(output);
  const outputParentStat = await lstat(outputParent);
  if (outputParentStat.isSymbolicLink() || !outputParentStat.isDirectory()) throw new Error('output parent must be a real directory, not symbolic links');
  const temporaryRoot = await realpath(tmpdir());
  const realOutputParent = await realpath(outputParent);
  const belowTemporaryRoot = relative(temporaryRoot, resolve(realOutputParent, basename(output)));
  if (belowTemporaryRoot === '' || belowTemporaryRoot.startsWith('..') || isAbsolute(belowTemporaryRoot)) {
    throw new Error('output must be below the operating system temporary directory');
  }
  try {
    await lstat(output);
    throw new Error('output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const requiredTools = [
    ['go', ['version']],
    ['helm', ['version', '--short']],
    ['kubeconform', ['-v']],
    ['conftest', ['--version']],
    ['yq', ['--version']],
  ];
  for (const [command, args] of requiredTools) toolProbe(command, args);

  const started = new Date().toISOString();
  await mkdir(output);
  createdOutput = output;
  await writeFile(resolve(output, '.section-9-evaluation.json'), `${JSON.stringify({
    schema: 'agentic-iac-section-9-evaluation/v1',
    source,
    started,
  }, null, 2)}\n`);

  const commands = [];
  function run(id, command, args, cwd, input = undefined, timeout = 180_000) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      input,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      timeout,
      env: {...process.env, CI: '1'},
    });
    const exit = result.status ?? (result.error?.code === 'ENOENT' ? 127 : 124);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    commands.push({
      id,
      argv: [command, ...args],
      cwd: relative(source, cwd) || '.',
      exit,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
    });
    return {exit, stdout, stderr};
  }
  function internalRecord(id, argv, exit, observation) {
    commands.push({id, argv, cwd: '.', exit, stdout_sha256: sha256(observation), stderr_sha256: sha256('')});
  }

  const toolVersions = {};
  for (const [command, args] of requiredTools) {
    const probe = run(`version-${command}`, command, args, source, undefined, 30_000);
    toolVersions[command] = (probe.stdout || probe.stderr).split('\n').find((line) => line.trim())?.trim() || `exit ${probe.exit}`;
  }

  const appTests = run('app-tests', 'go', ['test', './...'], resolve(source, 'app'));
  const helmLint = run('helm-lint', 'helm', ['lint', '--strict', resolve(source, 'chart')], source);
  const render = run('helm-render', 'helm', ['template', 'inference-platform', resolve(source, 'chart'), '--namespace', 'inference'], source);
  if (render.exit !== 0) throw new Error(`Helm render failed with exit ${render.exit}`);
  if (!render.stdout.trim()) throw new Error('empty render is not accepted');

  const schemaEmptyImage = run('schema-empty-image', 'helm', [
    'template', 'inference-platform', resolve(source, 'chart'), '--namespace', 'inference', '--set-string', 'image.tag=',
  ], source);
  const schemaInvalidPort = run('schema-invalid-api-port', 'helm', [
    'template', 'inference-platform', resolve(source, 'chart'), '--namespace', 'inference', '--set', 'service.api.port=70000',
  ], source);
  const schemaUnknownKey = run('schema-unknown-key', 'helm', [
    'template', 'inference-platform', resolve(source, 'chart'), '--namespace', 'inference', '--set', 'unexpected=true',
  ], source);

  const kubeconform = run('kubeconform', 'kubeconform', ['-strict', '-summary', '-'], source, render.stdout);
  const normalized = run('normalize-render', 'yq', ['-s', 'map(select(. != null))', '-'], source, render.stdout);
  if (normalized.exit !== 0) throw new Error(`render normalization failed with exit ${normalized.exit}`);
  let objects;
  try {
    objects = JSON.parse(normalized.stdout);
  } catch {
    throw new Error('normalized render is not valid JSON');
  }
  if (!Array.isArray(objects) || objects.length === 0) throw new Error('empty render is not accepted');

  const conftest = run('conftest', 'conftest', ['test', '-', '-p', resolve(source, 'policy'), '--output', 'json'], source, render.stdout);

  const valuesText = await readFile(resolve(source, 'chart/values.yaml'), 'utf8');
  const schema = JSON.parse(await readFile(resolve(source, 'chart/values.schema.json'), 'utf8'));
  const deployments = objects.filter(({kind}) => kind === 'Deployment');
  const services = objects.filter(({kind}) => kind === 'Service');
  const configMaps = objects.filter(({kind}) => kind === 'ConfigMap');
  const serviceAccounts = objects.filter(({kind}) => kind === 'ServiceAccount');
  const renderedSecrets = objects.filter(({kind}) => kind === 'Secret');
  const networkPolicies = objects.filter(({kind}) => kind === 'NetworkPolicy');
  const roles = ['dependencies', 'api', 'worker'];
  const deploymentFor = (role) => deployments.find((item) => item.metadata?.labels?.['app.kubernetes.io/component'] === role);
  const containerFor = (role) => deploymentFor(role)?.spec?.template?.spec?.containers?.[0];
  const envFor = (role) => containerFor(role)?.env || [];
  const envValue = (role, name) => envFor(role).find((entry) => entry.name === name);

  const workloadContractPass = deployments.length === 3
    && services.length === 2
    && configMaps.length === 1
    && serviceAccounts.length === 3
    && networkPolicies.length === 0
    && roles.every((role) => deploymentFor(role));
  const securityContextPass = roles.every((role) => {
    const pod = deploymentFor(role)?.spec?.template?.spec;
    const container = containerFor(role);
    return pod?.automountServiceAccountToken === false
      && pod?.serviceAccountName === `inference-platform-${role}`
      && pod?.securityContext?.runAsNonRoot === true
      && pod?.securityContext?.runAsUser === 65532
      && pod?.securityContext?.runAsGroup === 65532
      && pod?.securityContext?.fsGroup === 65532
      && pod?.securityContext?.fsGroupChangePolicy === 'OnRootMismatch'
      && pod?.securityContext?.seccompProfile?.type === 'RuntimeDefault'
      && container?.securityContext?.allowPrivilegeEscalation === false
      && container?.securityContext?.readOnlyRootFilesystem === true
      && container?.securityContext?.runAsNonRoot === true
      && container?.securityContext?.runAsUser === 65532
      && JSON.stringify(container?.securityContext?.capabilities?.drop) === JSON.stringify(['ALL']);
  });
  const probesPass = roles.every((role) => {
    const container = containerFor(role);
    return container?.livenessProbe?.httpGet?.path === '/healthz'
      && container?.readinessProbe?.httpGet?.path === '/readyz'
      && Number.isInteger(container?.livenessProbe?.httpGet?.port)
      && Number.isInteger(container?.readinessProbe?.httpGet?.port);
  });
  const roleBoundariesPass = envValue('dependencies', 'ROLE')?.value === 'dependencies'
    && envValue('dependencies', 'LISTEN_ADDRESS')?.value === ':8081'
    && !envValue('dependencies', 'BACKEND_URL')
    && envValue('api', 'ROLE')?.value === 'api'
    && envValue('api', 'LISTEN_ADDRESS')?.value === ':8080'
    && envValue('api', 'BACKEND_URL')?.valueFrom?.configMapKeyRef?.key === 'BACKEND_URL'
    && envValue('worker', 'ROLE')?.value === 'worker'
    && !envValue('worker', 'LISTEN_ADDRESS')
    && envValue('worker', 'BACKEND_URL')?.valueFrom?.configMapKeyRef?.key === 'BACKEND_URL'
    && roles.every((role) => envValue(role, 'BACKEND_TOKEN_FILE')?.value === '/var/run/secrets/inference/token');

  const backendSchema = schema.properties?.backend;
  const workerSchema = schema.properties?.resources?.properties?.worker;
  const backendSchemaPass = backendSchema?.required?.includes('existingSecret')
    && !backendSchema?.required?.includes('token')
    && backendSchema?.properties?.existingSecret
    && !backendSchema?.properties?.token;
  const workerSchemaPass = workerSchema?.$ref === '#/definitions/resources';
  const fixedSchemaNegativesPass = schemaEmptyImage.exit !== 0 && schemaInvalidPort.exit !== 0 && schemaUnknownKey.exit !== 0;
  const schemaChecksPass = RUN_SCHEMA_CHECKS && backendSchemaPass && workerSchemaPass && fixedSchemaNegativesPass;
  if (RUN_SCHEMA_CHECKS) {
    internalRecord('schema-worker-limits', ['internal:schema-contract', 'resources.worker.limits', 'backend.existingSecret'], schemaChecksPass ? 0 : 1, `${backendSchemaPass}:${workerSchemaPass}:${fixedSchemaNegativesPass}`);
  }

  const literalTokenLine = /^\s*(?:token|password|secret|api[_-]?key|access[_-]?key|private[_-]?key):\s*(?!(?:''|""|null)\s*$)\S+/im.test(valuesText);
  const secretMaterialFound = CHECK_SECRET_MATERIAL && (literalTokenLine || renderedSecrets.length > 0 || !backendSchemaPass);
  internalRecord('secret-scan', ['internal:secret-scan', 'chart/values.yaml', 'rendered-manifests'], secretMaterialFound ? 1 : 0, `${literalTokenLine}:${renderedSecrets.length}:${backendSchemaPass}`);

  const worker = containerFor('worker');
  const missingWorkerLimits = CHECK_RESOURCE_LIMITS && (!worker?.resources?.limits?.cpu || !worker?.resources?.limits?.memory || !workerSchemaPass);
  internalRecord('resource-limits', ['internal:resource-check', 'Deployment/inference-platform-worker'], missingWorkerLimits ? 1 : 0, `${Boolean(worker?.resources?.limits?.cpu)}:${Boolean(worker?.resources?.limits?.memory)}:${workerSchemaPass}`);

  let conftestMessages = [];
  try {
    conftestMessages = collectMessages(JSON.parse(conftest.stdout));
  } catch {
    conftestMessages = [];
  }
  const conftestMessagesExpected = conftestMessages.length > 0 && conftestMessages.every((message) => (
    /chart must reference an external Secret/i.test(message)
      || /inference-platform-worker\/worker requires a CPU limit/i.test(message)
      || /inference-platform-worker\/worker requires a memory limit/i.test(message)
  ));
  const readOnlySha256 = await scopedHash(source, READ_ONLY_FILES);
  const allowedSourceScopePass = readOnlySha256 === EXPECTED_READ_ONLY_SHA256;

  const gates = {
    app_tests: status(appTests.exit === 0, `go test exit ${appTests.exit}`),
    helm_lint: status(helmLint.exit === 0, `helm lint exit ${helmLint.exit}`),
    render: status(render.exit === 0 && objects.length > 0, `${objects.length} rendered objects`),
    schema: status(schemaChecksPass, `fixed negatives ${fixedSchemaNegativesPass}; external Secret schema ${Boolean(backendSchemaPass)}; worker limits schema ${workerSchemaPass}`),
    kubeconform: status(kubeconform.exit === 0, `exit ${kubeconform.exit}`),
    secret_scan: status(!secretMaterialFound, secretMaterialFound ? 'literal or rendered token material detected; value withheld' : 'no literal or rendered token material'),
    resource_limits: status(!missingWorkerLimits, missingWorkerLimits ? 'worker CPU or memory limits missing' : 'worker requests and limits present'),
    conftest: status(conftest.exit === 0, `exit ${conftest.exit}; ${conftestMessages.length} policy messages`),
    workload_contract: status(workloadContractPass, 'three Deployments, two Services, one ConfigMap, and three ServiceAccounts'),
    security_context: status(securityContextPass, 'non-root, seccomp, read-only root, dropped capabilities, and separate service accounts'),
    probes: status(probesPass, 'HTTP health and readiness probes for all roles'),
    role_boundaries: status(roleBoundariesPass, 'dependencies, API, worker, backend URL, and token-file interfaces'),
    allowed_source_scope: status(allowedSourceScopePass, allowedSourceScopePass ? 'only the three learner-owned chart files may differ' : 'a read-only app, chart, or policy file changed'),
  };

  const primaryFindings = [];
  if (secretMaterialFound) primaryFindings.push({
    id: 'committed-backend-token-material',
    title: 'Committed backend token material',
    evidence: 'A token-shaped value is committed and/or rendered; the value is intentionally withheld.',
    consequences: [
      ...(literalTokenLine ? ['chart values contain token-shaped material'] : []),
      ...(renderedSecrets.length ? ['the chart renders a Kubernetes Secret instead of referencing an existing Secret'] : []),
      ...(!backendSchemaPass ? ['the values schema admits the inline token path instead of requiring an existing Secret reference'] : []),
    ],
  });
  if (missingWorkerLimits) primaryFindings.push({
    id: 'missing-worker-resource-limits',
    title: 'Missing worker resource limits',
    evidence: 'The rendered worker and/or its schema does not require both CPU and memory limits.',
    consequences: [
      ...(!worker?.resources?.limits?.cpu ? ['worker CPU limit is absent'] : []),
      ...(!worker?.resources?.limits?.memory ? ['worker memory limit is absent'] : []),
      ...(!workerSchemaPass ? ['the values schema permits the worker limits to be omitted'] : []),
    ],
  });
  if (!allowedSourceScopePass) primaryFindings.push({
    id: 'changed-read-only-source',
    title: 'Changed read-only source',
    evidence: 'At least one app, policy, or non-owned chart file differs from the frozen baseline.',
    consequences: ['the evaluator cannot attribute the result to the bounded three-file learner repair'],
  });

  const unrelatedFailures = [
    ['application-contract-failure', gates.app_tests.status === 'FAIL'],
    ['helm-lint-failure', gates.helm_lint.status === 'FAIL'],
    ['render-contract-failure', gates.render.status === 'FAIL' || gates.kubeconform.status === 'FAIL' || gates.workload_contract.status === 'FAIL'],
    ['security-context-failure', gates.security_context.status === 'FAIL'],
    ['probe-contract-failure', gates.probes.status === 'FAIL'],
    ['role-boundary-failure', gates.role_boundaries.status === 'FAIL'],
    ['unexpected-policy-failure', conftest.exit !== 0 && !conftestMessagesExpected],
  ];
  for (const [id, failed] of unrelatedFailures) {
    if (failed) primaryFindings.push({id, title: id.replaceAll('-', ' '), evidence: 'An unrelated package contract failed.', consequences: []});
  }
  if (!RUN_SCHEMA_CHECKS) primaryFindings.push({id: 'schema-check-skipped', title: 'schema check skipped', evidence: 'The required schema contract did not run.', consequences: []});

  const decision = primaryFindings.length === 0 && Object.values(gates).every(({status: gateStatus}) => gateStatus === 'PASS')
    ? 'READY_FOR_HUMAN_REVIEW'
    : 'REJECTED';
  const completed = new Date().toISOString();
  const report = {
    schema: 'agentic-iac-section-9-evidence/v1',
    started,
    completed,
    source_sha256: await scopedHash(source, EVALUATED_FILES),
    evaluator_sha256: sha256(await readFile(new URL(import.meta.url))),
    artifacts: {
      app_sha256: await scopedHash(source, EVALUATED_FILES.filter((file) => file.startsWith('app/'))),
      chart_sha256: await scopedHash(source, EVALUATED_FILES.filter((file) => file.startsWith('chart/'))),
      policy_sha256: await scopedHash(source, EVALUATED_FILES.filter((file) => file.startsWith('policy/'))),
      read_only_sha256: readOnlySha256,
      render_sha256: sha256(render.stdout),
    },
    evaluated_files: EVALUATED_FILES,
    learner_owned_files: LEARNER_OWNED_FILES,
    tool_versions: toolVersions,
    decision,
    gates,
    primary_findings: primaryFindings,
    commands,
    proof_limits: [
      'This evaluator does not create a Kind cluster, namespace, release, image, or workload.',
      'Static rendering does not prove startup, request flow, resource use, cleanup, or NetworkPolicy enforcement.',
      'READY_FOR_HUMAN_REVIEW is not deployment approval.',
    ],
  };
  await writeFile(resolve(output, 'evidence-report.json'), `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});

  const summaryDecision = report.decision;
  console.log(`Section 9 package: ${summaryDecision}`);
  for (const finding of report.primary_findings) console.log(`FINDING ${finding.id}: ${finding.title}`);
  console.log(`Evidence: ${resolve(output, 'evidence-report.json')}`);
  process.exitCode = report.decision === 'READY_FOR_HUMAN_REVIEW' ? 0 : 1;
  createdOutput = null;
}

main().catch(async (error) => {
  if (createdOutput) await rm(createdOutput, {recursive: true, force: true});
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
});

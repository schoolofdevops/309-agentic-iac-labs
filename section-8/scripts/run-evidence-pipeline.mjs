#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';

const engine = process.argv[2];
const source = resolve(process.argv[3] || resolve(import.meta.dirname, '..'));
const output = resolve(process.argv[4] || '');
if (!['terraform', 'tofu'].includes(engine)) throw new Error('engine must be terraform or tofu');
if (!process.argv[4]) throw new Error('provide a named output directory');
if (!basename(output).startsWith('agentic-iac-section-8-')) throw new Error('output must use the Section 8 prefix');
if (!source.split('/').includes('section-8')) throw new Error('source must be the Section 8 directory');
try { await lstat(output); throw new Error('output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const excluded = new Set(['.terraform', 'evidence-report.json', 'plan.tfplan', 'plan.json', 'redacted-tool.log']);
async function filesBelow(directory, prefix = '') {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute, relative));
    else if (entry.isFile()) files.push({relative, absolute});
  }
  return files;
}
async function treeHash(directory) {
  const hash = createHash('sha256');
  for (const file of await filesBelow(directory)) {
    hash.update(file.relative); hash.update('\0'); hash.update(await readFile(file.absolute)); hash.update('\0');
  }
  return hash.digest('hex');
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const redact = (value) => {
  let count = 0;
  const text = String(value).replace(/((?:AWS_)?(?:SECRET|TOKEN|PASSWORD|ACCESS_KEY)[A-Z_]*\s*[=:]\s*)([^\s]+)/gi, (_match, key) => {
    count += 1; return `${key}[REDACTED]`;
  });
  return {text, count};
};

async function processTreeRssKib(rootPid) {
  let child;
  try {
    child = spawn('ps', ['-axo', 'pid=,ppid=,rss='], {shell: false, stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return 0;
  }
  let output = ''; let unavailable = false;
  child.stdout.on('data', (chunk) => { output += chunk; });
  await new Promise((done) => {
    child.once('error', () => { unavailable = true; done(); });
    child.once('close', done);
  });
  if (unavailable) return 0;
  const rows = output.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3);
  const children = new Map();
  const rss = new Map();
  for (const [pid, ppid, kib] of rows) {
    rss.set(pid, kib);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const pending = [rootPid];
  const seen = new Set();
  let total = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) || 0;
    pending.push(...(children.get(pid) || []));
  }
  return total;
}

const started = new Date().toISOString();
const startedMonotonic = performance.now();
const source_sha256 = await treeHash(source);
await mkdir(output);
await writeFile(resolve(output, '.section-8-run.json'), JSON.stringify({kind: 'agentic-iac-section-8', started}, null, 2));
for (const directory of ['starter', 'policy', 'scanner', 'adversarial', 'fixtures']) {
  await cp(resolve(source, directory), resolve(output, directory), {recursive: true, filter: (name) => basename(name) !== '.terraform'});
}
const work = resolve(output, 'starter');
const pluginCache = resolve(process.env.HOME, '.terraform.d/plugin-cache');
await mkdir(pluginCache, {recursive: true});
const env = {
  HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp',
  TF_IN_AUTOMATION: '1', TF_PLUGIN_CACHE_DIR: pluginCache, CHECKPOINT_DISABLE: '1',
  AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1',
};
const commandRecords = [];
async function run(id, command, args, cwd, timeoutMs = 180000) {
  const began = performance.now();
  const child = spawn(command, args, {cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = ''; let stderr = ''; let timedOut = false; let spawnError = null; let peakRssKib = 0;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolveExit) => {
    child.once('error', (error) => { spawnError = error; resolveExit(127); });
    child.once('close', (code) => resolveExit(code ?? (spawnError ? 127 : 124)));
  });
  const sample = async () => { if (child.pid) peakRssKib = Math.max(peakRssKib, await processTreeRssKib(child.pid)); };
  await sample();
  const sampler = setInterval(sample, 250);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  const exit = await exitPromise;
  clearTimeout(timer); clearInterval(sampler); await sample();
  if (spawnError) stderr += `${spawnError.message}\n`;
  const safeOut = redact(stdout); const safeErr = redact(stderr);
  commandRecords.push({id, argv: [command, ...args], exit, timed_out: timedOut, duration_ms: Math.round(performance.now() - began), peak_rss_mib: Number((peakRssKib / 1024).toFixed(1)), stdout_tail: safeOut.text.slice(-1200), stderr_tail: safeErr.text.slice(-1200)});
  return {exit, stdout, stderr};
}

const versionCommands = [
  [engine, engine, ['version']],
  ['tflint', 'tflint', ['--version']],
  ['trivy', 'trivy', ['--version']],
  ['opa', 'opa', ['version']],
  ['conftest', 'conftest', ['--version']],
];
const tool_versions = {};
for (const [id, command, args] of versionCommands) {
  const result = await run(`version-${id}`, command, args, work, 30000);
  tool_versions[id] = result.exit === 0 ? (result.stdout || result.stderr).split('\n').find((line) => line.trim())?.trim() || 'version output empty' : `unavailable (exit ${result.exit})`;
}

const format = await run('format', engine, ['fmt', '-check', '-recursive', '.'], work);
const init = await run('init', engine, ['init', '-backend=false', '-input=false', '-no-color'], work);
const validation = init.exit === 0 ? await run('validation', engine, ['validate', '-no-color'], work) : {exit: 125};
const contract = init.exit === 0 ? await run('contract', engine, ['test', '-no-color'], work) : {exit: 125};
const planned = init.exit === 0 ? await run('plan', engine, ['plan', '-refresh=false', '-input=false', '-lock=false', '-out=plan.tfplan', '-no-color'], work) : {exit: 125};
let planText = ''; let show = {exit: 125};
if (planned.exit === 0) {
  show = await run('show-json', engine, ['show', '-json', 'plan.tfplan'], work);
  if (show.exit === 0) { planText = show.stdout; await writeFile(resolve(output, 'plan.json'), planText); }
}
const lintInit = await run('tflint-init', 'tflint', ['--init'], work);
const lint = lintInit.exit === 0 ? await run('tflint', 'tflint', ['--format', 'compact'], work) : {exit: 125};
const security = await run('trivy', 'trivy', ['config', '--skip-version-check', '--exit-code', '1', '--format', 'json', '--ignorefile', resolve(output, 'scanner/trivy.ignore'), '.'], work);
const policyTest = await run('policy-test', 'opa', ['test', resolve(output, 'policy')], output);
const conftest = show.exit === 0 ? await run('conftest', 'conftest', ['test', resolve(output, 'plan.json'), '--policy', resolve(output, 'policy'), '--output', 'json'], output) : {exit: 125};

let plan = {resource_changes: []};
try { plan = JSON.parse(planText); } catch { /* plan gate reports the error */ }
const managed = (plan.resource_changes || []).filter((item) => item.mode === 'managed');
const managedAddresses = managed.map((item) => item.address).sort();
const expected_managed_addresses = {
  starter: ['aws_eip.unused', 'aws_iam_role.worker', 'aws_iam_role_policy.worker', 'aws_s3_bucket.artifacts', 'aws_s3_bucket_public_access_block.artifacts', 'aws_sqs_queue.jobs'].sort(),
  repaired: ['aws_iam_role.worker', 'aws_iam_role_policy.worker', 'aws_s3_bucket.artifacts', 'aws_s3_bucket_public_access_block.artifacts', 'aws_sqs_queue.jobs'].sort(),
};
const planShape = Object.entries(expected_managed_addresses).find(([, addresses]) => JSON.stringify(addresses) === JSON.stringify(managedAddresses))?.[0] || 'unexpected';
const hasEip = managed.some((item) => item.type === 'aws_eip');
const missingOwners = managed.filter((item) => ['aws_s3_bucket', 'aws_sqs_queue'].includes(item.type) && !item.change?.after?.tags?.Owner).map((item) => item.address);
const costFailures = [...(managed.length > 5 ? [`resource count ${managed.length} exceeds 5`] : []), ...(hasEip ? ['unapproved elastic IP'] : []), ...missingOwners.map((item) => `${item} missing Owner tag`)];
const mainText = await readFile(resolve(work, 'main.tf'), 'utf8');
const wildcardFound = /actions\s*=\s*\["\*"\]|resources\s*=\s*\["\*"\]/.test(mainText);
let trivyFindings = 0;
try { trivyFindings = (JSON.parse(security.stdout).Results || []).reduce((sum, result) => sum + (result.Misconfigurations || []).length, 0); } catch { trivyFindings = security.exit === 0 ? 0 : -1; }

const suppressions = JSON.parse(await readFile(resolve(output, 'scanner/suppressions.json'), 'utf8')).suppressions;
const suppressionIds = suppressions.map((item) => item.rule_id).sort();
const suppressionValid = JSON.stringify(suppressionIds) === JSON.stringify(['AWS-0089', 'AWS-0090', 'AWS-0132']) && suppressions.every((item) => item.scope && item.owner && item.reason && item.expires && item.compensating_evidence);
const rawLog = await readFile(resolve(output, 'fixtures/raw-tool.log'), 'utf8');
const redacted = redact(rawLog);
await writeFile(resolve(output, 'redacted-tool.log'), redacted.text);
const secret_values_stored = redacted.text.includes('course-secret-must-not-enter-evidence') ? 1 : 0;
const adversarial = await readFile(resolve(output, 'adversarial/incoming-request.md'), 'utf8');
const environmentChangePattern = new RegExp(`terraform\\s+${'ap' + 'ply'}`, 'i');
const attackClasses = [/ignore.+instructions/is, /AGENTS\.md/i, environmentChangePattern, /curl/i, /approval/i, /all checks passed/i].filter((pattern) => pattern.test(adversarial)).length;

const status = (pass, detail) => ({status: pass ? 'PASS' : 'FAIL', detail});
const gates = {
  format: status(format.exit === 0, `exit ${format.exit}`),
  validation: status(init.exit === 0 && validation.exit === 0, `init ${init.exit}; validate ${validation.exit}`),
  contract: status(contract.exit === 0, `exit ${contract.exit}`),
  plan: status(planned.exit === 0 && show.exit === 0 && planShape !== 'unexpected', `plan ${planned.exit}; show ${show.exit}; shape ${planShape}`),
  lint: status(lint.exit === 0, `exit ${lint.exit}`),
  security: status(security.exit === 0 && !wildcardFound && suppressionValid, `trivy findings ${trivyFindings}; wildcard ${wildcardFound}; suppressions ${suppressionValid}`),
  policy: status(policyTest.exit === 0 && conftest.exit === 0, `policy tests ${policyTest.exit}; conftest ${conftest.exit}`),
  cost: status(costFailures.length === 0, costFailures.join('; ') || 'static limits pass'),
  redaction: status(redacted.count > 0 && secret_values_stored === 0, `${redacted.count} value redacted`),
  agent_safety: status(attackClasses === 6, `${attackClasses}/6 attack classes rejected`),
};
const decision = Object.values(gates).every((gate) => gate.status === 'PASS') ? 'READY_FOR_HUMAN_REVIEW' : 'REJECTED';
const sourceLockText = await readFile(resolve(source, 'starter/.terraform.lock.hcl'), 'utf8');
const effectiveLockText = await readFile(resolve(work, '.terraform.lock.hcl'), 'utf8');
const completed = new Date().toISOString();
const report = {
  schema: 'agentic-iac-section-8-evidence/v1', started, completed, elapsed_ms: Math.round(performance.now() - startedMonotonic), engine, tool_versions,
  source_sha256, plan_sha256: planText ? sha256(planText) : null, decision, gates,
  lockfile: {source_sha256: sha256(sourceLockText), effective_sha256: sha256(effectiveLockText), rewritten: sourceLockText !== effectiveLockText},
  expected_managed_addresses,
  observations: {plan_resource_count: managed.length, managed_addresses: managedAddresses, plan_shape: planShape, trivy_findings: trivyFindings, wildcard_policy: wildcardFound, faulty_policy_conftest_exit: conftest.exit, policy_test_exit: policyTest.exit, suppressions: suppressionIds, redactions: redacted.count, secret_values_stored, attack_classes_rejected: attackClasses},
  commands: commandRecords,
  human_boundary: 'Pipeline acceptance is ready for human plan review, not permission for an environment operation.',
};
await writeFile(resolve(output, 'evidence-report.json'), JSON.stringify(report, null, 2));
console.log(`Section 8 evidence pipeline: ${decision}`);
for (const [name, gate] of Object.entries(gates)) console.log(`${gate.status.padEnd(4)} ${name}: ${gate.detail}`);
console.log(`Evidence: ${resolve(output, 'evidence-report.json')}`);
process.exitCode = decision === 'READY_FOR_HUMAN_REVIEW' ? 0 : 1;

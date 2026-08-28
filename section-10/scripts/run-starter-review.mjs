#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID = "section-10-task-3";
const GIT = "/usr/bin/git";
const RUNNER_PATH = "section-10/scripts/run-starter-review.mjs";
const CONTRACT_PATH = "section-10/contracts/starter-review.json";
const CANDIDATE_ROOT = "section-10/starter";
const PATHS = {
  changed: `${CANDIDATE_ROOT}/changed-files.txt`,
  decision: `${CANDIDATE_ROOT}/delivery-decision.json`,
  application: `${CANDIDATE_ROOT}/gitops/application.yaml`,
  terraform: `${CANDIDATE_ROOT}/terraform/main.tf`,
  terraformRoot: `${CANDIDATE_ROOT}/terraform`,
  workflow: `${CANDIDATE_ROOT}/workflows/terraform-plan.yml`,
  chart: `${CANDIDATE_ROOT}/gitops/chart`,
};
const TOOL_PROFILES = {
  terraform: {
    name: "terraform",
    candidates: ["/opt/homebrew/bin/terraform", "/usr/local/bin/terraform", "/usr/bin/terraform"],
    versionArgs: ["version", "-json"],
    version: (text) => JSON.parse(text).terraform_version,
    contractKey: "terraform",
  },
  opentofu: {
    name: "tofu",
    candidates: ["/opt/homebrew/bin/tofu", "/usr/local/bin/tofu", "/usr/bin/tofu"],
    versionArgs: ["version", "-json"],
    version: (text) => JSON.parse(text).terraform_version,
    contractKey: "opentofu",
  },
  helm: {
    name: "helm",
    candidates: ["/opt/homebrew/bin/helm", "/usr/local/bin/helm", "/usr/bin/helm"],
    versionArgs: ["version", "--short"],
    version: (text) => text.trim().split("+")[0],
    contractKey: "helm",
  },
  conftest: {
    name: "conftest",
    candidates: ["/opt/homebrew/bin/conftest", "/usr/local/bin/conftest", "/usr/bin/conftest"],
    versionArgs: ["--version"],
    version: (text) => text.match(/OPA:\s*([^\s]+)/)?.[1] ?? "",
    contractKey: "opa",
  },
};

class ReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reject(code, message) {
  throw new ReviewError(code, message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) reject("USAGE", `missing ${name}`);
  return process.argv[index + 1];
}

function optional(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (index === process.argv.length - 1) reject("USAGE", `missing value for ${name}`);
  return process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function framedSha256(parts) {
  const hash = createHash("sha256");
  for (const [name, bytes] of parts) {
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function minimalBaseEnvironment(home = realpathSync(tmpdir())) {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

function command(executable, args, cwd, env, accepted = [0], input) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env,
    input,
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!accepted.includes(result.status)) {
    reject("COMMAND_FAILED", `${basename(executable)} ${args[0]}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result;
}

function assertNoSymlinkComponents(input, allowMissingFinal = false) {
  const logicalTemporaryRoot = resolve(tmpdir());
  const canonicalTemporaryRoot = realpathSync(logicalTemporaryRoot);
  const requested = resolve(input);
  const absolute = requested === logicalTemporaryRoot || requested.startsWith(`${logicalTemporaryRoot}${sep}`)
    ? `${canonicalTemporaryRoot}${requested.slice(logicalTemporaryRoot.length)}`
    : requested;
  const parsed = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (let index = 0; index < parsed.length; index += 1) {
    current = join(current, parsed[index]);
    if (!existsSync(current)) {
      if (allowMissingFinal && index === parsed.length - 1) return absolute;
      reject("PATH_MISSING", current);
    }
    if (lstatSync(current).isSymbolicLink()) reject("SYMLINK_ANCESTOR", current);
  }
  return absolute;
}

function git(source, args, accepted = [0]) {
  return command(GIT, args, source, minimalBaseEnvironment(), accepted);
}

function gitText(source, args) {
  return git(source, args).stdout;
}

function validateRevision(source, name, value) {
  if (!/^[0-9a-f]{40}$/.test(value)) reject("REVISION_INVALID", `${name} must be a full Git SHA`);
  const resolved = gitText(source, ["rev-parse", `${value}^{commit}`]).trim();
  if (resolved !== value) reject("REVISION_INVALID", `${name} does not resolve exactly`);
}

function treeEntries(source, revision, root) {
  const output = gitText(source, ["ls-tree", "-rz", "-r", revision, "--", root]);
  return output.split("\0").filter(Boolean).map((record) => {
    const [metadata, path] = record.split("\t");
    const [mode, type, object] = metadata.split(" ");
    return { mode, type, object, path };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function blob(source, revision, path) {
  const entry = treeEntries(source, revision, path).find((candidate) => candidate.path === path);
  if (!entry || entry.mode !== "100644" || entry.type !== "blob") reject("CANDIDATE_FILE_INVALID", path);
  return Buffer.from(gitText(source, ["show", `${revision}:${path}`]));
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    reject(code, error.message);
  }
}

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertTrustedBootstrap(source, trustedRevision) {
  const current = readFileSync(fileURLToPath(import.meta.url));
  const reviewed = blob(source, trustedRevision, RUNNER_PATH);
  if (!current.equals(reviewed)) reject("TRUSTED_RUNNER_MISMATCH", "invoked launcher differs from the approved Git base");
  return parseJson(blob(source, trustedRevision, CONTRACT_PATH), "CONTRACT_INVALID");
}

function validateContract(contract) {
  if (contract.task_id !== TASK_ID || contract.trusted_runner !== RUNNER_PATH || contract.candidate_root !== CANDIDATE_ROOT
    || contract.evidence_schema !== "section-10/contracts/starter-evidence.schema.json"
    || contract.cleanup !== "section-10/scripts/cleanup-starter-evidence.mjs") {
    reject("CONTRACT_INVALID", "unexpected task, runner, or candidate root");
  }
  if (!sameKeys(contract.identities, ["author", "reviewer", "delivery", "runtime"]) || !sameKeys(contract.application, [
    "apiVersion", "kind", "name", "namespace", "project", "repoURL", "targetRevision", "path", "server", "destinationNamespace",
  ])) reject("CONTRACT_INVALID", "identity or Application contract is incomplete");
}

function validateEvidenceSchema(schema) {
  const expected = ["task_id", "trusted_revision", "candidate_revision", "status", "candidate_sha256", "findings", "terraform", "helm", "apply_permitted"];
  if (JSON.stringify(schema.required) !== JSON.stringify(expected) || schema.properties?.apply_permitted?.const !== false) {
    reject("EVIDENCE_SCHEMA_INVALID", "evidence schema no longer binds revisions or closed apply permission");
  }
}

function validateCandidateDiff(source, trusted, candidate, contract) {
  const changed = gitText(source, ["diff", "--name-only", "-z", "--no-renames", `${trusted}..${candidate}`, "--"])
    .split("\0").filter(Boolean).sort();
  const allowed = new Set(contract.learner_editable);
  const forbidden = changed.filter((path) => !allowed.has(path));
  if (forbidden.length) reject("CANDIDATE_SCOPE_FORBIDDEN", forbidden.join(", "));
}

function validateChart(source, trusted, candidate) {
  const reviewed = treeEntries(source, trusted, PATHS.chart);
  const proposed = treeEntries(source, candidate, PATHS.chart);
  if (reviewed.length === 0 || JSON.stringify(proposed) !== JSON.stringify(reviewed)) {
    reject("CHART_INVARIANT", "chart tree must exactly match the approved Git base");
  }
  return reviewed;
}

function validateWorkflow(source, trusted, candidate) {
  const reviewed = blob(source, trusted, PATHS.workflow);
  const proposed = blob(source, candidate, PATHS.workflow);
  if (!reviewed.equals(proposed)) reject("WORKFLOW_INVARIANT", "candidate workflow bytes changed");
  return proposed;
}

function validateTerraform(source, trusted, candidate) {
  const entries = treeEntries(source, candidate, PATHS.terraformRoot);
  if (entries.length !== 1 || entries[0].path !== PATHS.terraform || entries[0].mode !== "100644" || entries[0].type !== "blob") {
    reject("TERRAFORM_TREE_INVALID", "exactly one regular main.tf is permitted");
  }
  const bytes = blob(source, candidate, PATHS.terraform);
  const text = bytes.toString("utf8");
  if (/\brequired_providers\b|\bprovider\s+"/.test(text)) reject("PROVIDER_FORBIDDEN", PATHS.terraform);
  if (/\bbackend\s+"|\bcloud\s*\{/.test(text)) reject("BACKEND_FORBIDDEN", PATHS.terraform);
  if (/\bmodule\s+"|\bterraform_remote_state\b|https?:\/\//.test(text)) reject("MODULE_FORBIDDEN", PATHS.terraform);
  if (/\bdata\s+"/.test(text)) reject("DATA_FORBIDDEN", PATHS.terraform);
  if (/\b(?:file|filebase64|templatefile|fileset)\s*\(/.test(text)) reject("FUNCTION_FORBIDDEN", PATHS.terraform);
  if (/\bprovisioner\s+"|\bconnection\s*\{|\blocal-exec\b|\bremote-exec\b/.test(text)) reject("EXECUTION_CONSTRUCT_FORBIDDEN", PATHS.terraform);
  for (const match of text.matchAll(/\bresource\s+"([^"]+)"\s+"([^"]+)"/g)) {
    if (match[1] !== "terraform_data" || match[2] !== "reviewed_delivery") reject("RESOURCE_SCHEMA_FORBIDDEN", `${match[1]}.${match[2]}`);
  }
  const reviewed = blob(source, trusted, PATHS.terraform);
  if (!bytes.equals(reviewed)) reject("TERRAFORM_SCHEMA_INVALID", "Terraform intent differs from the approved provider-free schema");
  return bytes;
}

function validateDecision(input, contract) {
  if (!sameKeys(input, ["kind", "task_id", "identities", "approval", "apply_permitted"])
    || input.kind !== "DeliveryDecision" || input.task_id !== TASK_ID || input.apply_permitted !== false
    || !sameKeys(input.identities, ["author", "reviewer", "delivery", "runtime"])
    || JSON.stringify(input.identities) !== JSON.stringify(contract.identities)
    || !sameKeys(input.approval, ["requested_by", "approved_by"])
    || input.approval.requested_by !== contract.identities.author
    || ![contract.identities.author, contract.identities.reviewer].includes(input.approval.approved_by)) {
    reject("DECISION_SCHEMA_INVALID", "decision identities and approval must match the fixed course contract");
  }
}

function validateChangedFiles(bytes, contract) {
  const values = bytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  const normalized = [...new Set(values)].sort();
  if (values.length !== normalized.length) reject("CHANGED_FILES_INVALID", "duplicates are not permitted");
  const accepted = JSON.stringify(normalized) === JSON.stringify([...contract.accepted_changed_files].sort());
  const unsafe = JSON.stringify(normalized) === JSON.stringify([...contract.unsafe_changed_files].sort());
  if (!accepted && !unsafe) reject("CHANGED_FILES_INVALID", "changed files must match one exact reviewed set");
  return normalized;
}

function resolveTool(profile, contract, explicitPath, expectedSha) {
  let executable;
  if (explicitPath || expectedSha) {
    if (!explicitPath || !expectedSha || !isAbsolute(explicitPath) || !/^[0-9a-f]{64}$/.test(expectedSha)) reject("TOOL_BINDING_INVALID", profile.name);
    assertNoSymlinkComponents(dirname(explicitPath));
    if (lstatSync(explicitPath).isSymbolicLink() || basename(explicitPath) !== profile.name || sha256(readFileSync(explicitPath)) !== expectedSha) reject("TOOL_BINDING_INVALID", profile.name);
    const parent = realpathSync(dirname(explicitPath));
    const temporaryRoot = realpathSync(tmpdir());
    const parentMetadata = statSync(parent);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : parentMetadata.uid;
    if (dirname(parent) !== temporaryRoot || !basename(parent).startsWith("agentic-iac-s10-engine-")
      || parentMetadata.uid !== currentUid || (parentMetadata.mode & 0o077) !== 0) {
      reject("TOOL_BINDING_INVALID", "explicit engine must be in an evaluator-owned temporary directory");
    }
    executable = explicitPath;
  } else {
    const fixed = profile.candidates.find((candidate) => existsSync(candidate));
    if (!fixed) reject("TOOL_NOT_FOUND", profile.name);
    executable = realpathSync(fixed);
  }
  const canonical = realpathSync(executable);
  const metadata = statSync(canonical);
  const uid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (!metadata.isFile() || basename(canonical) !== profile.name || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0 || ![0, uid].includes(metadata.uid)) {
    reject("TOOL_UNTRUSTED", canonical);
  }
  const observed = profile.version(command(canonical, profile.versionArgs, dirname(canonical), minimalBaseEnvironment()).stdout);
  if (observed !== contract.versions[profile.contractKey]) reject("TOOL_VERSION_MISMATCH", `${profile.name}: ${observed}`);
  return canonical;
}

function executionEnvironment(work) {
  const home = join(work, "home");
  const data = join(work, "tf-data");
  const temporary = join(work, "tmp");
  for (const path of [home, data, temporary]) mkdirSync(path, { recursive: true, mode: 0o700 });
  return {
    CHECKPOINT_DISABLE: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TF_DATA_DIR: data,
    TF_IN_AUTOMATION: "true",
    TMPDIR: temporary,
  };
}

function materializeTree(source, revision, entries, root, destination) {
  for (const entry of entries) {
    if (entry.mode !== "100644" || entry.type !== "blob") reject("CHART_INVARIANT", entry.path);
    const output = join(destination, relative(root, entry.path));
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, blob(source, revision, entry.path), { mode: 0o600 });
  }
}

function parseApplication(conftest, bytes, work, contract) {
  const path = join(work, "application.yaml");
  writeFileSync(path, bytes, { mode: 0o600 });
  let parsed;
  try {
    const output = command(conftest, ["parse", path], work, minimalBaseEnvironment()).stdout;
    const decoded = JSON.parse(output);
    parsed = Array.isArray(decoded) ? decoded[0]?.contents : decoded;
  } catch (error) {
    reject("APPLICATION_SCHEMA_INVALID", error.message);
  }
  const expected = contract.application;
  const syncKeys = Object.keys(parsed?.spec?.syncPolicy ?? {}).sort();
  const syncShape = JSON.stringify(syncKeys) === JSON.stringify(["syncOptions"])
    || JSON.stringify(syncKeys) === JSON.stringify(["automated", "syncOptions"]);
  const automated = parsed?.spec?.syncPolicy?.automated;
  const automatedShape = automated === undefined || (sameKeys(automated, ["prune", "selfHeal"]) && automated.prune === true && automated.selfHeal === true);
  if (!sameKeys(parsed, ["apiVersion", "kind", "metadata", "spec"])
    || parsed.apiVersion !== expected.apiVersion || parsed.kind !== expected.kind
    || !sameKeys(parsed.metadata, ["name", "namespace"]) || parsed.metadata.name !== expected.name || parsed.metadata.namespace !== expected.namespace
    || !sameKeys(parsed.spec, ["project", "source", "destination", "syncPolicy"]) || parsed.spec.project !== expected.project
    || !sameKeys(parsed.spec.source, ["repoURL", "targetRevision", "path"])
    || parsed.spec.source.repoURL !== expected.repoURL || parsed.spec.source.targetRevision !== expected.targetRevision || parsed.spec.source.path !== expected.path
    || !sameKeys(parsed.spec.destination, ["server", "namespace"]) || parsed.spec.destination.server !== expected.server || parsed.spec.destination.namespace !== expected.destinationNamespace
    || !syncShape || !automatedShape || JSON.stringify(parsed.spec.syncPolicy.syncOptions) !== JSON.stringify(["CreateNamespace=false"])) {
    reject("APPLICATION_SCHEMA_INVALID", "Application fields differ from the fixed GitOps contract");
  }
  return parsed;
}

function conftestFindings(conftest, input, policy, work) {
  const inputPath = join(work, "candidate.json");
  const policyPath = join(work, "delivery.rego");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(policyPath, policy, { mode: 0o600 });
  const result = command(conftest, ["test", inputPath, "--policy", policyPath, "--output", "json"], work, minimalBaseEnvironment(), [0, 1]);
  const output = JSON.parse(result.stdout || "[]");
  return output.flatMap((entry) => entry.failures ?? []).map((failure) => ({
    id: failure.metadata?.id ?? failure.msg?.id,
    message: failure.metadata?.msg ?? failure.msg?.msg ?? failure.msg,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function verifyTerraform(engine, bytes, work) {
  const root = join(work, basename(engine));
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "main.tf"), bytes, { mode: 0o600 });
  const env = executionEnvironment(join(work, `${basename(engine)}-environment`));
  command(engine, ["-chdir=.", "fmt", "-check", "-no-color"], root, env);
  command(engine, ["-chdir=.", "init", "-backend=false", "-input=false", "-no-color"], root, env);
  command(engine, ["-chdir=.", "validate", "-no-color"], root, env);
}

function verifyChart(helm, conftest, source, trusted, chartEntries, workloadPolicy, work) {
  const chart = join(work, "chart");
  mkdirSync(chart, { mode: 0o700 });
  materializeTree(source, trusted, chartEntries, PATHS.chart, chart);
  command(helm, ["lint", chart], work, minimalBaseEnvironment());
  const rendered = command(helm, ["template", "inference-platform", chart, "--namespace", "inference"], work, minimalBaseEnvironment()).stdout;
  const policyRoot = join(work, "workload-policy");
  mkdirSync(policyRoot, { mode: 0o700 });
  writeFileSync(join(policyRoot, "workload.rego"), workloadPolicy, { mode: 0o600 });
  const renderedPath = join(work, "rendered.yaml");
  writeFileSync(renderedPath, rendered, { mode: 0o600 });
  command(conftest, ["test", renderedPath, "--parser", "yaml", "--policy", policyRoot, "--output", "json"], work, minimalBaseEnvironment());
  if (/^kind: Secret$/m.test(rendered) || !/name: inference-platform-backend-token/.test(rendered) || /^kind: NetworkPolicy$/m.test(rendered)) {
    reject("CHART_RUNTIME_CONTRACT", "Secret reference or core NetworkPolicy contract changed");
  }
}

function createOutput(requested) {
  assertNoSymlinkComponents(dirname(resolve(requested)));
  const logical = resolve(tmpdir());
  const canonical = realpathSync(logical);
  const absolute = resolve(requested);
  if (![logical, canonical].includes(dirname(absolute)) || !basename(absolute).startsWith("agentic-iac-s10-")) reject("OUTPUT_OUTSIDE_TEMP", absolute);
  if (existsSync(absolute)) reject("OUTPUT_EXISTS", absolute);
  mkdirSync(absolute, { mode: 0o700 });
  return realpathSync(absolute);
}

function main() {
  let scratch;
  let output;
  try {
    const sourceInput = argument("--source");
    assertNoSymlinkComponents(sourceInput);
    const source = realpathSync(sourceInput);
    const trusted = argument("--trusted-revision");
    const candidate = argument("--candidate-revision");
    validateRevision(source, "trusted revision", trusted);
    validateRevision(source, "candidate revision", candidate);
    if (git(source, ["merge-base", "--is-ancestor", trusted, candidate], [0, 1]).status !== 0) reject("TRUSTED_BASE_NOT_ANCESTOR", trusted);
    const contract = assertTrustedBootstrap(source, trusted);
    validateContract(contract);
    validateEvidenceSchema(parseJson(blob(source, trusted, contract.evidence_schema), "EVIDENCE_SCHEMA_INVALID"));

    const chartEntries = validateChart(source, trusted, candidate);
    const workflow = validateWorkflow(source, trusted, candidate);
    const terraform = validateTerraform(source, trusted, candidate);
    validateCandidateDiff(source, trusted, candidate, contract);
    const changedFiles = validateChangedFiles(blob(source, candidate, PATHS.changed), contract);
    const decision = parseJson(blob(source, candidate, PATHS.decision), "DECISION_SCHEMA_INVALID");
    validateDecision(decision, contract);

    scratch = mkdtempSync(join(realpathSync(tmpdir()), "agentic-iac-s10-review-work-"));
    const conftest = resolveTool(TOOL_PROFILES.conftest, contract);
    const application = parseApplication(conftest, blob(source, candidate, PATHS.application), scratch, contract);
    const findings = conftestFindings(conftest, {
      kind: "Section10Candidate",
      changed_files: changedFiles,
      decision,
      documents: [
        { path: PATHS.workflow, contents: JSON.parse(command(conftest, ["parse", "--parser", "yaml", "-"], scratch, minimalBaseEnvironment(), [0], workflow).stdout) },
        { path: PATHS.application, contents: application },
      ],
    }, blob(source, trusted, contract.delivery_policy), scratch);

    const explicitEngine = optional("--engine");
    const enginePath = optional("--engine-path");
    const engineSha = optional("--engine-sha256");
    if ((enginePath || engineSha) && !explicitEngine) reject("TOOL_BINDING_INVALID", "explicit engine binding requires --engine");
    const engines = explicitEngine ? [explicitEngine] : ["terraform", "opentofu"];
    if (engines.some((name) => !["terraform", "opentofu"].includes(name))) reject("UNKNOWN_ENGINE", "accepted values are terraform and opentofu");
    for (const name of engines) {
      const executable = resolveTool(TOOL_PROFILES[name], contract, enginePath, engineSha);
      verifyTerraform(executable, terraform, scratch);
    }
    const helm = resolveTool(TOOL_PROFILES.helm, contract);
    verifyChart(helm, conftest, source, trusted, chartEntries, blob(source, trusted, contract.workload_policy), scratch);

    output = createOutput(argument("--output"));
    const report = {
      task_id: TASK_ID,
      trusted_revision: trusted,
      candidate_revision: candidate,
      status: findings.length ? "REJECTED" : "READY_FOR_HUMAN_REVIEW",
      candidate_sha256: framedSha256([
        [PATHS.changed, blob(source, candidate, PATHS.changed)],
        [PATHS.decision, blob(source, candidate, PATHS.decision)],
        [PATHS.application, blob(source, candidate, PATHS.application)],
        [PATHS.terraform, terraform],
      ]),
      findings,
      terraform: Object.fromEntries(engines.map((name) => [name, "VALID"])),
      helm: { lint: "PASS", render: "PASS", workload_policy: "PASS", external_secret_reference: true, network_policy_rendered: false },
      apply_permitted: false,
    };
    writeFileSync(join(output, ".agentic-iac-s10-evidence-root"), `${TASK_ID}\n`, { mode: 0o600 });
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${report.status}: ${findings.length} primary finding(s); evidence ${output}\n`);
    if (findings.length) process.exitCode = 2;
  } catch (error) {
    if (output && existsSync(output)) rmSync(output, { recursive: true, force: true });
    const code = error instanceof ReviewError ? error.code : "REVIEW_ERROR";
    process.stderr.write(`REJECTED ${code}: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
}

main();

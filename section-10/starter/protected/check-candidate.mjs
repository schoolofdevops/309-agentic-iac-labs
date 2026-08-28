#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID = "section-10-task-3";
const FINDING_IDS = [
  "S10_ARGO_AUTOMATION_ENABLED",
  "S10_AUTHOR_SELF_APPROVAL",
  "S10_PRIVILEGED_WORKFLOW_CHANGED",
];
const TOOL_PATHS = {
  conftest: "/opt/homebrew/bin/conftest",
  helm: "/opt/homebrew/bin/helm",
  terraform: "/opt/homebrew/bin/terraform",
  opentofu: "/opt/homebrew/bin/tofu",
};

class EvaluationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reject(code, message) {
  throw new EvaluationError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRegular(root, relative) {
  if (isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) reject("PATH_ESCAPE", relative);
  const path = resolve(root, relative);
  if (!path.startsWith(`${root}${sep}`)) reject("PATH_ESCAPE", relative);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    reject("FILE_MISSING", `${relative}: ${error.message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) reject("UNSAFE_FILE_TYPE", relative);
  return path;
}

function parseArguments() {
  const candidate = process.argv[2];
  const output = process.argv[3];
  if (!candidate || !output) reject("USAGE", "check-candidate.mjs <candidate> <new-output> [--overrides <directory>]");
  const overrideIndex = process.argv.indexOf("--overrides");
  const overrides = overrideIndex < 0 ? undefined : process.argv[overrideIndex + 1];
  if (overrideIndex >= 0 && !overrides) reject("USAGE", "--overrides requires a directory");
  return { candidate, output, overrides };
}

function command(executable, args, options = {}, accepted = [0]) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    ...options,
  });
  if (!accepted.includes(result.status)) {
    reject("COMMAND_FAILED", `${basename(executable)} ${args[0]}: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result;
}

function createOutput(requested) {
  const logicalTemporaryRoot = resolve(tmpdir());
  const temporaryRoot = realpathSync(logicalTemporaryRoot);
  const absolute = resolve(requested);
  if (dirname(absolute) !== logicalTemporaryRoot && dirname(absolute) !== temporaryRoot) reject("OUTPUT_OUTSIDE_TEMP", absolute);
  if (!basename(absolute).startsWith("agentic-iac-s10-")) reject("OUTPUT_PREFIX", basename(absolute));
  if (existsSync(absolute)) reject("OUTPUT_EXISTS", absolute);
  mkdirSync(absolute, { mode: 0o700 });
  const canonical = realpathSync(absolute);
  writeFileSync(join(canonical, ".agentic-iac-s10-evidence.json"), `${JSON.stringify({ task_id: TASK_ID, path: canonical })}\n`, { mode: 0o600 });
  return canonical;
}

function selectedPath(candidate, overrides, relative) {
  if (!overrides) return safeRegular(candidate, relative);
  const replacement = resolve(overrides, relative);
  if (replacement.startsWith(`${overrides}${sep}`) && existsSync(replacement)) return safeRegular(overrides, relative);
  return safeRegular(candidate, relative);
}

function validateOverrides(overrides, editable) {
  if (!overrides) return;
  const listing = command("/usr/bin/find", [overrides, "-type", "f", "-print"], {}).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(overrides.length + 1).replaceAll("\\", "/"))
    .sort();
  for (const relative of listing) {
    if (!editable.includes(relative)) reject("OVERRIDE_SCOPE_FORBIDDEN", relative);
  }
}

function minimalEnvironment(work) {
  const home = join(work, "home");
  const data = join(work, "tf-data");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  return {
    CHECKPOINT_DISABLE: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    TF_DATA_DIR: data,
    TF_IN_AUTOMATION: "true",
  };
}

function verifyTerraform(output, mainPath) {
  const terraformRoot = join(output, "terraform");
  mkdirSync(terraformRoot, { mode: 0o700 });
  cpSync(mainPath, join(terraformRoot, "main.tf"), { dereference: true });
  const statuses = {};
  for (const [name, executable] of [["terraform", TOOL_PATHS.terraform], ["opentofu", TOOL_PATHS.opentofu]]) {
    const engineWork = mkdtempSync(join(output, `${name}-`));
    const env = minimalEnvironment(engineWork);
    command(executable, [`-chdir=${terraformRoot}`, "init", "-backend=false", "-input=false", "-no-color"], { env });
    command(executable, [`-chdir=${terraformRoot}`, "validate", "-no-color"], { env });
    statuses[name] = "VALID";
  }
  return statuses;
}

function verifyHelm(chartPath) {
  command(TOOL_PATHS.helm, ["lint", chartPath], { env: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", PATH: "/opt/homebrew/bin:/usr/bin:/bin" } });
  const render = command(TOOL_PATHS.helm, ["template", "inference-platform", chartPath, "--namespace", "inference"], {
    env: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
  }).stdout;
  if (/^kind: Secret$/m.test(render) || !/name: inference-platform-backend-token/.test(render)) reject("HELM_SECRET_CONTRACT", "chart must reference, not render, the external Secret");
  if (/^kind: NetworkPolicy$/m.test(render)) reject("HELM_NETWORK_POLICY_CONTRACT", "core Kind values must leave NetworkPolicy disabled");
  return { lint: "PASS", render: "PASS", external_secret_reference: true, network_policy_rendered: false };
}

function conftestFindings(inputPath, policyPath) {
  const result = command(TOOL_PATHS.conftest, ["test", inputPath, "--policy", policyPath, "--output", "json"], {}, [0, 1]);
  const output = JSON.parse(result.stdout || "[]");
  const findings = [];
  for (const fileResult of output) {
    for (const failure of fileResult.failures ?? []) {
      const metadata = failure.metadata ?? {};
      const id = metadata.id ?? failure.msg?.id;
      const message = metadata.msg ?? failure.msg?.msg ?? failure.msg;
      if (typeof id !== "string" || typeof message !== "string") reject("POLICY_OUTPUT_INVALID", JSON.stringify(failure));
      findings.push({ id, message });
    }
  }
  return findings.sort((left, right) => left.id.localeCompare(right.id));
}

function main() {
  let output;
  try {
    const args = parseArguments();
    const candidate = realpathSync(resolve(args.candidate));
    const overrides = args.overrides ? realpathSync(resolve(args.overrides)) : undefined;
    const sectionRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const manifestPath = safeRegular(candidate, "protected/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.task_id !== TASK_ID) reject("MANIFEST_INVALID", "unexpected task_id");
    if (JSON.stringify([...manifest.primary_finding_ids].sort()) !== JSON.stringify(FINDING_IDS)) reject("MANIFEST_INVALID", "finding contract changed");
    validateOverrides(overrides, manifest.learner_editable);

    for (const [relative, expected] of Object.entries(manifest.protected_sha256)) {
      const root = relative.startsWith("../") ? sectionRoot : candidate;
      const local = relative.startsWith("../") ? relative.slice(3) : relative;
      const actual = sha256(readFileSync(safeRegular(root, local)));
      if (actual !== expected) reject("PROTECTED_FILE_CHANGED", `${relative}: expected ${expected}, got ${actual}`);
    }

    output = createOutput(args.output);
    const workflowPath = safeRegular(candidate, "workflows/terraform-plan.yml");
    const applicationPath = selectedPath(candidate, overrides, "gitops/application.yaml");
    const parse = command(TOOL_PATHS.conftest, ["parse", "--combine", workflowPath, applicationPath]);
    const input = {
      kind: "Section10Candidate",
      changed_files: readFileSync(selectedPath(candidate, overrides, "changed-files.txt"), "utf8").split(/\r?\n/).filter(Boolean),
      decision: JSON.parse(readFileSync(selectedPath(candidate, overrides, "delivery-decision.json"), "utf8")),
      documents: JSON.parse(parse.stdout),
    };
    const knownChanged = new Set([
      "section-10/starter/terraform/main.tf",
      "section-10/starter/gitops/application.yaml",
      "section-10/starter/workflows/terraform-plan.yml",
    ]);
    for (const changed of input.changed_files) if (!knownChanged.has(changed)) reject("CHANGED_FILE_UNKNOWN", changed);
    const inputPath = join(output, "candidate-input.json");
    writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });

    const terraform = verifyTerraform(output, selectedPath(candidate, overrides, "terraform/main.tf"));
    const helm = verifyHelm(safeRegular(candidate, "gitops/chart/Chart.yaml").replace(/\/Chart\.yaml$/, ""));
    const findings = conftestFindings(inputPath, safeRegular(sectionRoot, "policy/delivery.rego"));
    const candidateBytes = manifest.learner_editable.map((relative) => readFileSync(selectedPath(candidate, overrides, relative)));
    const report = {
      task_id: TASK_ID,
      status: findings.length === 0 ? "READY_FOR_HUMAN_REVIEW" : "REJECTED",
      candidate_sha256: sha256(Buffer.concat(candidateBytes)),
      findings,
      terraform,
      helm,
      apply_permitted: false,
    };
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${report.status}: ${findings.length} primary finding(s); evidence ${output}\n`);
    if (findings.length > 0) process.exitCode = 2;
  } catch (error) {
    if (output && existsSync(output)) rmSync(output, { recursive: true, force: true });
    const code = error instanceof EvaluationError ? error.code : "EVALUATION_ERROR";
    process.stderr.write(`REJECTED ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();

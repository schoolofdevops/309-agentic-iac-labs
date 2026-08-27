#!/usr/bin/env node
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
  applyOperations,
  changedFiles,
  copyFixture,
  deriveSummary,
  estimateTokens,
  fileSha256,
  loadContext,
  prepareOutput,
  readJson,
  resolveInside,
  runCommand,
  sectionRoot,
  sha256,
  snapshotSource,
} from './lib/core.mjs';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('use --engine <terraform|tofu> [--plan <path>] --output <absolute-temp-path>');
    }
    result[flag.slice(2)] = value;
  }
  if (!['terraform', 'tofu'].includes(result.engine)) {
    throw new Error('engine must be terraform or tofu');
  }
  if (!result.output) throw new Error('output is required');
  return result;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const planRelative = options.plan ?? 'starter/workflow/plan.json';
  const planPath = resolveInside(sectionRoot, planRelative, 'plan path');
  const plan = readJson(planPath);
  const output = prepareOutput(options.output);
  const workspace = path.join(output, 'workspace');
  const rawDirectory = path.join(output, 'raw');
  mkdirSync(workspace);
  mkdirSync(rawDirectory);
  copyFixture(workspace);

  const fixturePath = path.join(sectionRoot, 'fixture', 'main.tf');
  const taskPath = path.join(sectionRoot, 'task.md');
  const priceCardPath = path.join(sectionRoot, 'starter', 'budget', 'price-card.json');
  const runCardPath = path.join(sectionRoot, 'starter', 'run-card.json');
  const before = snapshotSource(workspace);
  const context = loadContext(plan.context);

  applyOperations(workspace, plan.operations);

  const commands = [];
  const fixedCommands = [
    ['fmt', '-check', '-diff', 'main.tf'],
    ['init', '-backend=false', '-input=false', '-no-color'],
    ['validate', '-no-color'],
  ];
  for (let repeat = 0; repeat < plan.validation_repeats; repeat += 1) {
    for (const args of fixedCommands) {
      commands.push(runCommand(options.engine, args, workspace));
    }
  }

  const after = snapshotSource(workspace);
  const sourceChanges = changedFiles(before, after);
  const outputBytes = commands.reduce(
    (sum, command) => sum + Buffer.byteLength(command.stdout) + Buffer.byteLength(command.stderr),
    0,
  );
  const contextBytes = context.reduce((sum, item) => sum + item.bytes.length, 0);
  const priceCard = readJson(priceCardPath);
  const inputTokens = estimateTokens(contextBytes);
  const outputTokens = estimateTokens(outputBytes);
  const estimatedCost =
    inputTokens * priceCard.input_usd_per_million_tokens / 1_000_000
    + outputTokens * priceCard.output_usd_per_million_tokens / 1_000_000;
  const mainTf = readFileSync(path.join(workspace, 'main.tf'), 'utf8');
  const summary = deriveSummary(mainTf);
  const functionalPass =
    commands.every((command) => command.exit_code === 0 && !command.timed_out)
    && summary === 'queue_name=course-jobs;nullable=false';

  const rawLogPath = path.join(rawDirectory, 'commands.ndjson');
  writeFileSync(
    rawLogPath,
    `${commands.map((command) => JSON.stringify(command)).join('\n')}\n`,
  );

  const run = {
    schema_version: 1,
    intent: plan.intent,
    engine: options.engine,
    shell: false,
    timeout_ms: 30_000,
    child_environment_keys: ['CHECKPOINT_DISABLE', 'HOME', 'PATH', 'TF_INPUT', 'TF_IN_AUTOMATION', 'TMPDIR'],
    hashes: {
      fixture_sha256: fileSha256(fixturePath),
      task_sha256: fileSha256(taskPath),
      plan_sha256: fileSha256(planPath),
      price_card_sha256: fileSha256(priceCardPath),
    },
    context: {
      files: context.map((item) => item.path),
      bytes: contextBytes,
      estimated_tokens: inputTokens,
      estimate_method: priceCard.token_estimate_method,
    },
    execution: {
      fixed_command_contract: fixedCommands.map((args) => [options.engine, ...args]),
      validation_repeats: plan.validation_repeats,
      configured_retry_limit: plan.retry_limit,
      observed_retry_count: 0,
      command_count: commands.length,
      commands: commands.map(({stdout, stderr, ...command}) => ({
        ...command,
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
      })),
      raw_log: 'raw/commands.ndjson',
      ignored_ephemeral_paths: ['.terraform/'],
    },
    changes: {
      derived_from_bytes: true,
      files: sourceChanges,
    },
    result: {
      observed_summary: summary,
      functional_pass: functionalPass,
    },
    output: {
      bytes: outputBytes,
      estimated_tokens: outputTokens,
    },
    cost: {
      label: priceCard.label,
      estimated_usd: Number(estimatedCost.toFixed(8)),
      provider_bill: false,
    },
    run_card: readJson(runCardPath),
  };
  writeFileSync(path.join(output, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);

  console.log(`Workflow run: ${functionalPass ? 'FUNCTIONAL PASS' : 'FUNCTIONAL FAIL'}`);
  console.log(`Engine: ${options.engine}`);
  console.log(`Changed files: ${sourceChanges.join(', ') || 'none'}`);
  console.log(`Commands: ${commands.length}`);
  console.log(`Context estimate: ${inputTokens} tokens`);
  console.log(`Output estimate: ${outputTokens} tokens`);
  console.log(`Evidence: ${path.join(output, 'run.json')}`);
  process.exitCode = functionalPass ? 0 : 1;
} catch (error) {
  console.error(`Workflow run: ERROR\n${error.message}`);
  process.exitCode = 2;
}

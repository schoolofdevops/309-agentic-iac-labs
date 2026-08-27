#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import path from 'node:path';

function readCard(directory) {
  if (!path.isAbsolute(directory)) throw new Error('run paths must be absolute');
  return JSON.parse(readFileSync(path.join(directory, 'run-card.json'), 'utf8'));
}

try {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    throw new Error('Use: node section-6/scripts/compare-runs.mjs <baseline-run> <candidate-run>');
  }
  const baseline = readCard(baselinePath);
  const candidate = readCard(candidatePath);
  const rows = [
    ['Decision', baseline.decision, candidate.decision],
    ['Passed gates', baseline.gates.filter((gate) => gate.passed).length, candidate.gates.filter((gate) => gate.passed).length],
    ['Changed files', baseline.changed_files.join(', '), candidate.changed_files.join(', ')],
    ['Commands', baseline.telemetry.command_count, candidate.telemetry.command_count],
    ['Retries', baseline.telemetry.retry_count, candidate.telemetry.retry_count],
    ['Context estimate', baseline.telemetry.context_estimated_tokens, candidate.telemetry.context_estimated_tokens],
    ['Output estimate', baseline.telemetry.output_estimated_tokens, candidate.telemetry.output_estimated_tokens],
    ['Estimated USD', baseline.telemetry.estimated_cost_usd, candidate.telemetry.estimated_cost_usd],
    ['Failure classes', baseline.failure_classes.join(', ') || 'none', candidate.failure_classes.join(', ') || 'none'],
  ];
  const widths = [
    Math.max('Metric'.length, ...rows.map((row) => String(row[0]).length)),
    Math.max('Baseline'.length, ...rows.map((row) => String(row[1]).length)),
  ];
  console.log(`${'Metric'.padEnd(widths[0])}  ${'Baseline'.padEnd(widths[1])}  Candidate`);
  console.log(`${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(24)}`);
  for (const row of rows) {
    console.log(`${String(row[0]).padEnd(widths[0])}  ${String(row[1]).padEnd(widths[1])}  ${row[2]}`);
  }
} catch (error) {
  console.error(`Run comparison: ERROR\n${error.message}`);
  process.exitCode = 2;
}

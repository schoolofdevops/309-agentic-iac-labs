#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packRoot = resolve(process.argv[2] ?? 'section-3/starter');
const problems = [];

function report(artifact, field, message) {
  problems.push(`${artifact} [${field}]: ${message}`);
}

function readArtifact(relativePath) {
  const path = resolve(packRoot, relativePath);
  if (!existsSync(path)) {
    report(relativePath, 'artifact', 'Required artifact is missing.');
    return '';
  }
  return readFileSync(path, 'utf8');
}

function requireHeadings(relativePath, source, headings) {
  for (const heading of headings) {
    const pattern = new RegExp(`^## ${heading}\\s*$`, 'im');
    if (!pattern.test(source)) {
      report(relativePath, `section.${heading.toLowerCase().replaceAll(' ', '-')}`, `Add the ${heading} section.`);
    }
  }
}

function tableValue(source, rowName) {
  const escaped = rowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+)\\|`, 'im'));
  return match?.[1].trim() ?? '';
}

function environmentState(source, environment) {
  const escaped = environment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+)\\|`, 'im'));
  return match?.[1].replaceAll('`', '').trim() ?? '';
}

const briefPath = 'change-brief.md';
const statePath = 'environment-state-map.md';
const adrPath = 'decisions/0001-queue-ownership.md';
const architecturePath = 'architecture/queue-feature.calm.json';

const brief = readArtifact(briefPath);
const stateMap = readArtifact(statePath);
const adr = readArtifact(adrPath);
const architectureSource = readArtifact(architecturePath);

if (brief) {
  requireHeadings(briefPath, brief, [
    'Outcome',
    'Acceptance criteria',
    'Assumptions',
    'Non-goals',
    'Change class',
    'Approval',
    'Rollback intent',
  ]);
  const criteria = brief.match(/^\d+\.\s+/gm) ?? [];
  if (criteria.length < 4) {
    report(briefPath, 'acceptance-criteria', 'Add at least four observable acceptance criteria.');
  }
}

if (stateMap) {
  const owners = [
    'Terraform',
    'Helm',
    'GitOps',
    'Application configuration',
    'Secret management',
  ];
  for (const owner of owners) {
    if (!new RegExp(`\\|\\s*${owner}\\s*\\|`, 'i').test(stateMap)) {
      report(statePath, 'lifecycle-ownership', `Add a lifecycle row for ${owner}.`);
    }
  }

  const terraformContents = tableValue(stateMap, 'Terraform state contents');
  if (/job payload|job status|result data|secret value/i.test(terraformContents)) {
    report(
      statePath,
      'terraform-state.contents',
      'Application job data belongs to the application, not Terraform state.',
    );
  }

  const testState = environmentState(stateMap, 'test');
  const productionState = environmentState(stateMap, 'production');
  if (testState && productionState && testState === productionState) {
    report(
      statePath,
      'environments.test.state',
      'Test and production must use different Terraform state.',
    );
  }
}

if (adr) {
  requireHeadings(adrPath, adr, [
    'Status',
    'Context',
    'Decision',
    'Alternatives considered',
    'Consequences',
    'Rollback intent',
    'Approval',
  ]);
}

if (architectureSource) {
  let architecture;
  try {
    architecture = JSON.parse(architectureSource);
  } catch (error) {
    report(architecturePath, 'json', `Invalid JSON: ${error.message}`);
  }

  if (architecture) {
    if (architecture.$schema !== 'https://calm.finos.org/release/1.2/meta/calm.json') {
      report(architecturePath, '$schema', 'Use the pinned FINOS CALM 1.2 schema.');
    }
    if (!Array.isArray(architecture.nodes) || architecture.nodes.length < 4) {
      report(architecturePath, 'nodes', 'Model the API, queue, worker, and runtime data store.');
    }
    if (!Array.isArray(architecture.relationships) || architecture.relationships.length < 3) {
      report(architecturePath, 'relationships', 'Model the queue and result-data paths.');
    }
    const boundaries = architecture.metadata?.['trust-boundaries'];
    if (!Array.isArray(boundaries) || boundaries.length < 2) {
      report(architecturePath, 'metadata.trust-boundaries', 'Name at least two trust boundaries.');
    }
  }
}

if (problems.length > 0) {
  console.log(`Design pack: NEEDS WORK (${problems.length} design problems found)`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Design pack: PASS (0 design problems found)');
  console.log('The local ownership and safety rules are satisfied.');
}

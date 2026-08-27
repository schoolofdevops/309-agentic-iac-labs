import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sectionRoot = fileURLToPath(new URL('..', import.meta.url));
const starterRoot = fileURLToPath(new URL('../starter/', import.meta.url));
const validator = fileURLToPath(new URL('../scripts/check-context-pack.mjs', import.meta.url));
const checksPath = fileURLToPath(new URL('../../labs/m4/checks.json', import.meta.url));

function read(relativePath) {
  const absolutePath = `${sectionRoot}/${relativePath}`;
  assert.ok(existsSync(absolutePath), `missing Section 4 artifact: ${relativePath}`);
  return readFileSync(absolutePath, 'utf8');
}

test('ships the immutable source corpus and four-layer context starter', () => {
  for (const relativePath of [
    'request.md',
    'task.md',
    'sources/manifest.json',
    'sources/policy/current-iac-policy.md',
    'sources/modules/job-queue-contract.md',
    'sources/decisions/adr-0002-shared-queue-state.md',
    'sources/observations/validation-2026-08-26.md',
    'sources/incidents/incident-042-state-collision.md',
    'sources/issues/issue-184.md',
    'starter/AGENTS.md',
    'starter/wiki/schema.md',
    'starter/wiki/index.md',
    'starter/wiki/queue-context.md',
    'starter/wiki/log.md',
    'starter/evidence/graph.json',
    'starter/retrieval/context-pack.md',
  ]) {
    read(relativePath);
  }

  const queueContext = read('starter/wiki/queue-context.md');
  const instructions = read('starter/AGENTS.md');
  assert.match(instructions, /platform and global rules/i);
  assert.match(instructions, /repository rules/i);
  assert.match(instructions, /directory instructions/i);
  assert.match(instructions, /current task/i);
  for (const layer of [
    'Durable rules',
    'Architecture memory',
    'Task context',
    'Current runtime evidence',
  ]) {
    assert.match(queueContext, new RegExp(layer, 'i'), `missing context layer: ${layer}`);
  }
});

test('uses a small typed evidence graph with reviewable provenance', () => {
  const graph = JSON.parse(read('starter/evidence/graph.json'));
  assert.ok(Array.isArray(graph.nodes) && graph.nodes.length >= 6);
  assert.ok(Array.isArray(graph.edges) && graph.edges.length >= 5);

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.source), `unknown graph source: ${edge.source}`);
    assert.ok(nodeIds.has(edge.target), `unknown graph target: ${edge.target}`);
    assert.match(edge.type, /^(SUPPORTS|CONTRADICTS|ABOUT|DERIVED_FROM|EVALUATES)$/);
    assert.match(edge.sourceRef, /^SRC-|^OBS-/);
    assert.match(edge.timestamp, /^2026-/);
    assert.match(edge.authoringRun, /^run-/);
  }
});

test('preserves the exact five unsafe context decisions in the starter', () => {
  assert.ok(existsSync(validator), 'the context-pack validator is missing');
  const result = spawnSync(process.execPath, [validator, starterRoot, `${sectionRoot}/sources`], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, `expected a failing starter\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Context pack: NEEDS WORK \(5 context problems found\)/);
  assert.match(result.stdout, /AGENTS\.md \[precedence\.untrusted-input\]/);
  assert.match(result.stdout, /wiki\/queue-context\.md \[claim\.shared-state\]/);
  assert.match(result.stdout, /evidence\/graph\.json \[edge\.issue-184-bypass\]/);
  assert.match(result.stdout, /retrieval\/context-pack\.md \[sources\.required\]/);
  assert.match(result.stdout, /retrieval\/context-pack\.md \[sources\.untrusted\]/);
  assert.doesNotMatch(result.stdout, /missing artifact|invalid JSON|checksum mismatch/i);
});

test('publishes the author-side Section 4 check command', () => {
  const contract = JSON.parse(readFileSync(checksPath, 'utf8'));
  assert.deepEqual(contract.checks, [
    {
      id: 'section-4-context-pack-contract',
      describe: 'the Section 4 starter preserves five trust and retrieval failures',
      run: 'node --test section-4/tests/context-pack-contract.test.mjs',
      assert: { exit: 0 },
      weight: 3,
    },
  ]);
});

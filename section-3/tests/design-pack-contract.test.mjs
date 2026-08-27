import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sectionRoot = fileURLToPath(new URL('..', import.meta.url));
const starterRoot = fileURLToPath(new URL('../starter/', import.meta.url));
const validator = fileURLToPath(
  new URL('../scripts/check-design-pack.mjs', import.meta.url),
);
const checksPath = fileURLToPath(new URL('../../labs/m3/checks.json', import.meta.url));

const requiredArtifacts = [
  'change-brief.md',
  'environment-state-map.md',
  'decisions/0001-queue-ownership.md',
  'architecture/queue-feature.calm.json',
];

test('ships a structurally complete Section 3 design-pack starter', () => {
  assert.ok(existsSync(`${sectionRoot}/request.md`), 'the queue feature request is missing');

  for (const artifact of requiredArtifacts) {
    assert.ok(existsSync(`${starterRoot}/${artifact}`), `missing starter artifact: ${artifact}`);
  }

  const architecture = JSON.parse(
    readFileSync(`${starterRoot}/architecture/queue-feature.calm.json`, 'utf8'),
  );
  assert.equal(
    architecture.$schema,
    'https://calm.finos.org/release/1.2/meta/calm.json',
  );
  assert.ok(Array.isArray(architecture.nodes) && architecture.nodes.length >= 4);
  assert.ok(
    Array.isArray(architecture.relationships) && architecture.relationships.length >= 3,
  );
});

test('models the five lifecycle owners with human-readable vocabulary', () => {
  const stateMap = readFileSync(`${starterRoot}/environment-state-map.md`, 'utf8');

  for (const owner of [
    'Terraform',
    'Helm',
    'GitOps',
    'Application configuration',
    'Secret management',
  ]) {
    assert.match(stateMap, new RegExp(owner, 'i'), `missing lifecycle owner: ${owner}`);
  }
});

test('local validation reports exactly the two intentional design failures', () => {
  assert.ok(existsSync(validator), 'the local design-pack validator is missing');

  const result = spawnSync(process.execPath, [validator, starterRoot], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, `expected an unsafe starter\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /2 design problems found/);
  assert.match(
    result.stdout,
    /environment-state-map\.md \[terraform-state\.contents\]: Application job data belongs to the application, not Terraform state\./,
  );
  assert.match(
    result.stdout,
    /environment-state-map\.md \[environments\.test\.state\]: Test and production must use different Terraform state\./,
  );
  assert.doesNotMatch(result.stdout, /missing|required artifact|invalid JSON/i);
});

test('publishes the author-side check command', () => {
  const contract = JSON.parse(readFileSync(checksPath, 'utf8'));
  assert.deepEqual(contract.checks, [
    {
      id: 'section-3-design-pack-contract',
      describe: 'the Section 3 starter preserves the two design failures and complete scaffold',
      run: 'node --test section-3/tests/design-pack-contract.test.mjs',
      assert: { exit: 0 },
      weight: 3,
    },
  ]);
});

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

test('models useful API and queue interfaces in the data-flow relationships', () => {
  const architecture = JSON.parse(
    readFileSync(`${starterRoot}/architecture/queue-feature.calm.json`, 'utf8'),
  );
  const nodes = new Map(architecture.nodes.map((node) => [node['unique-id'], node]));
  const relationships = new Map(
    architecture.relationships.map((relationship) => [
      relationship['unique-id'],
      relationship,
    ]),
  );

  const apiInterfaces = nodes.get('workload-api')?.interfaces ?? [];
  const queueInterfaces = nodes.get('job-queue')?.interfaces ?? [];

  assert.ok(
    apiInterfaces.some(
      (entry) =>
        entry['unique-id'] === 'jobs-api' &&
        entry.protocol === 'HTTPS' &&
        entry.port === 443 &&
        entry.path === '/v1/jobs',
    ),
    'the workload API needs a useful HTTPS jobs interface',
  );
  assert.ok(
    queueInterfaces.some(
      (entry) =>
        entry['unique-id'] === 'queue-publish' &&
        entry.protocol === 'AMQPS' &&
        entry.port === 5671,
    ),
    'the queue needs a secure publisher interface',
  );
  assert.ok(
    queueInterfaces.some(
      (entry) =>
        entry['unique-id'] === 'queue-consume' &&
        entry.protocol === 'AMQPS' &&
        entry.port === 5671,
    ),
    'the queue needs a secure consumer interface',
  );

  assert.deepEqual(
    relationships.get('api-publishes-job')?.['relationship-type']?.connects
      ?.destination?.interfaces,
    ['queue-publish'],
  );
  assert.deepEqual(
    relationships.get('worker-consumes-job')?.['relationship-type']?.connects
      ?.source?.interfaces,
    ['queue-consume'],
  );
});

test('records security and operational controls as design requirements, not runtime proof', () => {
  const architecture = JSON.parse(
    readFileSync(`${starterRoot}/architecture/queue-feature.calm.json`, 'utf8'),
  );

  assert.match(
    architecture.metadata?.['controls-evidence-boundary'] ?? '',
    /design requirements.+not proof.+runtime enforcement/i,
  );

  for (const controlId of ['secure-queue-data-flow', 'operable-job-queue']) {
    const control = architecture.controls?.[controlId];
    assert.ok(control, `missing architecture control: ${controlId}`);
    assert.match(control.description, /design requirement/i);
    assert.ok(Array.isArray(control.requirements) && control.requirements.length > 0);

    for (const requirement of control.requirements) {
      assert.match(
        requirement['requirement-url'],
        /^https:\/\/calm\.finos\.org\/(?:getting-started\/controls|draft\/2025-03\/samples\/traderx\/control-requirement)\//,
      );
      assert.equal(
        Number(Object.hasOwn(requirement, 'config')) +
          Number(Object.hasOwn(requirement, 'config-url')),
        1,
        'each control requirement needs exactly one config or config-url',
      );
    }
  }
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sectionRoot = fileURLToPath(new URL('..', import.meta.url));
const starterRoot = fileURLToPath(new URL('../starter/', import.meta.url));
const validator = fileURLToPath(new URL('../scripts/check-capability-pack.mjs', import.meta.url));
const probe = fileURLToPath(new URL('../starter/mcp/probe.mjs', import.meta.url));
const checksPath = fileURLToPath(new URL('../../labs/m5/checks.json', import.meta.url));

function read(relativePath) {
  const absolutePath = `${sectionRoot}/${relativePath}`;
  assert.ok(existsSync(absolutePath), `missing Section 5 artifact: ${relativePath}`);
  return readFileSync(absolutePath, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

test('ships the provider-free review fixture and immutable incoming evidence', () => {
  for (const relativePath of [
    'request.md',
    'task.md',
    'fixture/main.tf',
    'fixture/queue-context.md',
    'incoming/manifest.json',
    'incoming/skills/repository-operator/SKILL.md',
    'incoming/skills/repository-operator/scripts/run.sh',
    'incoming/server-admission-request.json',
    'starter/runner/command-contract.json',
    'starter/skills/terraform-review/SKILL.md',
    'starter/mcp/server.mjs',
    'starter/mcp/probe.mjs',
    'starter/admission/decision.json',
  ]) {
    read(relativePath);
  }

  const manifest = JSON.parse(read('incoming/manifest.json'));
  assert.equal(manifest.schema, 'course.agentic-iac.immutable-inputs/v1');
  assert.equal(manifest.mutable, false);
  for (const entry of manifest.files) {
    assert.equal(sha256(read(`incoming/${entry.path}`)), entry.sha256, `changed immutable input: ${entry.path}`);
  }

  const request = JSON.parse(read('incoming/server-admission-request.json'));
  assert.equal(request.schema, 'course.agentic-iac.capability-admission/v1');
  assert.equal(request.manifestType, 'course-control-artifact');
  assert.equal(request.isMcpStandardManifest, false);
  assert.match(request.notice, /not part of the MCP specification/i);
});

test('validates the same provider-free Terraform fixture without plan or apply', () => {
  for (const executable of ['terraform', 'tofu']) {
    const tempRoot = mkdtempSync(join(tmpdir(), `m5-${executable}-`));
    try {
      cpSync(`${sectionRoot}/fixture`, tempRoot, { recursive: true });
      const environment = {
        ...process.env,
        CHECKPOINT_DISABLE: '1',
        TF_IN_AUTOMATION: '1',
      };
      const format = spawnSync(executable, ['fmt', '-check', '-diff', 'main.tf'], {
        cwd: tempRoot,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(format.status, 0, `${executable} fmt check failed\n${format.stdout}${format.stderr}`);
      const init = spawnSync(executable, ['init', '-backend=false', '-input=false', '-no-color'], {
        cwd: tempRoot,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(init.status, 0, `${executable} init failed\n${init.stdout}${init.stderr}`);
      const validation = spawnSync(executable, ['validate', '-no-color'], {
        cwd: tempRoot,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(validation.status, 0, `${executable} validate failed\n${validation.stdout}${validation.stderr}`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('defines a fixed no-shell CLI review contract', () => {
  const contract = JSON.parse(read('starter/runner/command-contract.json'));
  assert.equal(contract.shell, false);
  assert.equal(contract.timeoutMs, 30000);
  assert.equal(contract.workingDirectory, 'section-5/fixture');
  assert.deepEqual(contract.environment, {
    CHECKPOINT_DISABLE: '1',
    TF_IN_AUTOMATION: '1',
  });
  assert.deepEqual(contract.allowedExecutables, ['terraform', 'tofu']);
  assert.deepEqual(contract.commands, [
    ['fmt', '-check', '-diff', 'main.tf'],
    ['init', '-backend=false', '-input=false', '-no-color'],
    ['validate', '-no-color'],
  ]);
  assert.deepEqual(contract.forbiddenOperations, ['plan', 'apply', 'destroy', 'state']);
});

test('serves one source-linked MCP resource with the 2026-07-28 stateless exchange', () => {
  assert.ok(existsSync(probe), 'the MCP probe is missing');
  const contextBefore = sha256(read('fixture/queue-context.md'));
  const terraformBefore = sha256(read('fixture/main.tf'));
  const result = spawnSync(process.execPath, [probe], {
    cwd: sectionRoot,
    encoding: 'utf8',
    env: { ...process.env, CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1' },
  });
  const contextAfter = sha256(read('fixture/queue-context.md'));
  const terraformAfter = sha256(read('fixture/main.tf'));

  assert.equal(result.status, 0, `MCP probe failed\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^MCP resource probe: PASS$/m);
  assert.match(result.stdout, /^Protocol: 2026-07-28$/m);
  assert.match(result.stdout, /^Resources: 1$/m);
  assert.match(result.stdout, /^Tools capability: absent$/m);
  assert.match(result.stdout, /^Unknown resource URI: rejected with -32602$/m);
  assert.match(result.stdout, /^Missing request metadata: rejected with -32602$/m);
  assert.match(result.stdout, /^Unknown method: rejected with -32601$/m);
  assert.equal(contextAfter, contextBefore, 'the MCP exchange changed its context source');
  assert.equal(terraformAfter, terraformBefore, 'the MCP exchange changed its Terraform fixture');
});

test('preserves exactly five understandable capability findings in the starter', () => {
  assert.ok(existsSync(validator), 'the capability-pack validator is missing');
  const result = spawnSync(process.execPath, [validator, starterRoot, `${sectionRoot}/incoming`], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, `expected a failing starter\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Capability pack: NEEDS WORK \(5 capability problems found\)/);
  assert.match(result.stdout, /skills\/terraform-review\/SKILL\.md \[skill\.procedure\]/);
  assert.match(result.stdout, /admission\/decision\.json \[incoming-skill\.decision\]/);
  assert.match(result.stdout, /admission\/decision\.json \[incoming-server\.decision\]/);
  assert.match(result.stdout, /admission\/decision\.json \[incoming-server\.reasons\]/);
  assert.match(result.stdout, /admission\/decision\.json \[metadata\.enforcement\]/);
  assert.doesNotMatch(result.stdout, /missing artifact|invalid JSON|checksum mismatch|MCP contract/i);
});

test('publishes the author-side Section 5 check command', () => {
  const contract = JSON.parse(readFileSync(checksPath, 'utf8'));
  assert.deepEqual(contract.checks, [
    {
      id: 'section-5-capability-pack-contract',
      describe: 'the Section 5 starter preserves five capability admission failures',
      run: 'node --test section-5/tests/capability-pack-contract.test.mjs',
      assert: { exit: 0 },
      weight: 3,
    },
  ]);
});

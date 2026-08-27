import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skillRoot = fileURLToPath(new URL('../', import.meta.url));
const starterRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sectionRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const runner = `${skillRoot}/scripts/review-iac.mjs`;
const evidenceRoot = `${starterRoot}/evidence`;
const trustPath = `${starterRoot}/admission/trust.json`;
const decisionPath = `${starterRoot}/admission/decision.json`;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('ships a complete bounded Skill candidate', () => {
  for (const path of [
    runner,
    `${skillRoot}/references/command-contract.md`,
    trustPath,
  ]) {
    assert.ok(existsSync(path), `missing candidate artifact: ${path}`);
  }

  const skill = readFileSync(`${skillRoot}/SKILL.md`, 'utf8');
  assert.match(skill, /^name: terraform-review$/m);
  assert.match(skill, /^description: .+$/m);
  assert.match(skill, /^compatibility: .+$/m);
  assert.match(skill, /^  owner: .+$/m);
  assert.match(skill, /^  version: ['"]?1\.0\.0['"]?$/m);
  assert.match(skill, /^## Procedure$/m);
  assert.match(skill, /^## Inputs$/m);
  assert.match(skill, /^## Outputs$/m);
  assert.match(skill, /^## Stop conditions$/m);
  assert.match(skill, /references\/command-contract\.md/);
  assert.match(skill, /scripts\/review-iac\.mjs/);
});

test('runner rejects engines and arguments outside the fixed contract', () => {
  const badEngine = spawnSync(process.execPath, [runner, '--engine', 'bash'], { encoding: 'utf8' });
  assert.equal(badEngine.status, 2);
  assert.match(badEngine.stderr, /engine must be terraform or tofu/);

  const extraArgument = spawnSync(process.execPath, [runner, '--engine', 'terraform', '--command', 'plan'], {
    encoding: 'utf8',
  });
  assert.equal(extraArgument.status, 2);
  assert.match(extraArgument.stderr, /unknown argument: --command/);
});

test('runner rejects evidence paths and accepts only a JSON file name', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'm5-evidence-scope-'));
  const invalidNames = [
    `${tempRoot}/absolute.json`,
    '../escape.json',
    'nested/review.json',
    'nested\\review.json',
    '.',
    '..',
    '.hidden.json',
    'review..json',
  ];
  try {
    for (const name of invalidNames) {
      const result = spawnSync(process.execPath, [runner, '--engine', 'terraform', '--evidence', name], {
        cwd: tempRoot,
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, `runner accepted unsafe evidence name: ${name}`);
      assert.match(result.stderr, /evidence must be a JSON file name/);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('runner redacts secret-shaped tool output and does not pass caller secrets', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'm5-redaction-'));
  const binRoot = `${tempRoot}/bin`;
  const evidenceName = `redaction-${process.pid}.json`;
  const evidencePath = `${evidenceRoot}/${evidenceName}`;
  mkdirSync(binRoot);
  writeFileSync(
    `${binRoot}/terraform`,
    `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s\\n' 'Terraform v0.0.0-test'
else
  printf '%s\\n' '{"password":"visible-password"}'
  printf '%s\\n' 'Authorization: Bearer visible-token' >&2
  if [ -n "$TF_VAR_demo_secret" ]; then
    printf '%s\\n' 'CALLER_SECRET_WAS_PASSED' >&2
  fi
fi
`,
  );
  chmodSync(`${binRoot}/terraform`, 0o755);

  try {
    const result = spawnSync(process.execPath, [runner, '--engine', 'terraform', '--evidence', evidenceName], {
      cwd: sectionRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: binRoot,
        TF_VAR_demo_secret: 'caller-secret',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const evidenceText = readFileSync(evidencePath, 'utf8');
    assert.doesNotMatch(evidenceText, /visible-password|visible-token|caller-secret|CALLER_SECRET_WAS_PASSED/);
    assert.match(evidenceText, /\[REDACTED\]/);
  } finally {
    rmSync(evidencePath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const engine of ['terraform', 'tofu']) {
  test(`runner validates the fixture with ${engine} and writes review evidence`, () => {
    const tempRoot = mkdtempSync(join(tmpdir(), `m5-runner-${engine}-`));
    const evidenceName = `${engine}-${process.pid}.json`;
    const evidencePath = `${evidenceRoot}/${evidenceName}`;
    const fixtureHashBefore = sha256File(`${sectionRoot}/fixture/main.tf`);
    try {
      const result = spawnSync(process.execPath, [runner, '--engine', engine, '--evidence', evidenceName], {
        cwd: sectionRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CHECKPOINT_DISABLE: '1',
          TF_IN_AUTOMATION: '1',
          TF_VAR_demo_secret: 'do-not-print-this-value',
        },
        timeout: 45000,
      });

      assert.equal(result.status, 0, `${engine} runner failed\n${result.stdout}${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, new RegExp(`IaC review: PASS \\(${engine}\\)`));
      assert.ok(existsSync(evidencePath), 'runner did not write evidence');

      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      assert.equal(evidence.schema, 'course.agentic-iac.review-evidence/v1');
      assert.equal(evidence.runnerVersion, '1.0.0');
      assert.equal(evidence.engine, engine);
      assert.match(evidence.engineVersion, new RegExp(engine === 'terraform' ? '^Terraform v' : '^OpenTofu v'));
      assert.equal(evidence.sourceWorkingDirectory, 'section-5/fixture');
      assert.equal(evidence.evidenceFile, `section-5/starter/evidence/${evidenceName}`);
      assert.equal(evidence.shell, false);
      assert.equal(evidence.timeoutMs, 30000);
      assert.equal(evidence.passed, true);
      assert.match(evidence.inputSha256, /^[a-f0-9]{64}$/);
      assert.match(evidence.contractSha256, /^[a-f0-9]{64}$/);
      assert.equal(evidence.inputSha256, fixtureHashBefore);
      assert.equal(evidence.commands.length, 3);
      assert.deepEqual(evidence.commands.map(({ argv }) => argv), [
        ['fmt', '-check', '-diff', 'main.tf'],
        ['init', '-backend=false', '-input=false', '-no-color'],
        ['validate', '-no-color'],
      ]);
      for (const command of evidence.commands) {
        assert.equal(command.executable, engine);
        assert.equal(command.exitCode, 0);
        assert.equal(command.timedOut, false);
        assert.equal(typeof command.durationMs, 'number');
        assert.equal(typeof command.stdout, 'string');
        assert.equal(typeof command.stderr, 'string');
        assert.doesNotMatch(`${command.stdout}${command.stderr}`, /do-not-print-this-value/);
      }
      assert.equal(sha256File(`${sectionRoot}/fixture/main.tf`), fixtureHashBefore, 'runner changed the source fixture');
    } finally {
      rmSync(evidencePath, { force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('trust evidence pins admitted local artifacts and denies broad authority', () => {
  const trust = JSON.parse(readFileSync(trustPath, 'utf8'));
  assert.equal(trust.schema, 'course.agentic-iac.capability-trust/v1');
  assert.equal(trust.defaultDecision, 'deny');
  assert.equal(trust.networkAllowed, false);
  assert.deepEqual(trust.secretPatternsAllowed, []);
  assert.deepEqual(trust.forbiddenOperations, ['plan', 'apply', 'destroy', 'state']);

  const artifacts = new Map(trust.artifacts.map((entry) => [entry.path, entry]));
  for (const relativePath of [
    'skills/terraform-review/SKILL.md',
    'skills/terraform-review/references/command-contract.md',
    'skills/terraform-review/scripts/review-iac.mjs',
    'runner/command-contract.json',
    'mcp/server.mjs',
  ]) {
    const entry = artifacts.get(relativePath);
    assert.ok(entry, `trust evidence does not pin ${relativePath}`);
    assert.equal(entry.sha256, sha256File(`${starterRoot}/${relativePath}`));
  }

  assert.equal(trust.skill.owner, 'course-maintainers');
  assert.equal(trust.skill.version, '1.0.0');
  assert.deepEqual(trust.skill.allowedExecutables, ['terraform', 'tofu']);
  assert.equal(trust.mcp.capability, 'resources-only');
  assert.equal(trust.mcp.owner, 'course-maintainers');
  assert.equal(trust.mcp.version, '1.0.0');
  assert.equal(trust.mcp.protocolVersion, '2026-07-28');
  assert.deepEqual(trust.mcp.startupArgv, ['node', 'section-5/starter/mcp/server.mjs']);
  assert.equal(trust.mcp.controlArtifactBoundary, 'course control; not MCP protocol metadata');
  assert.deepEqual(trust.mcp.source, {
    path: 'section-5/fixture/queue-context.md',
    sha256: sha256File(`${sectionRoot}/fixture/queue-context.md`),
  });
  assert.equal(trust.revocation.action, 'remove admission and rotate the pinned artifact hashes');
});

test('admission admits bounded local capabilities and rejects both incoming requests', () => {
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  const decisions = new Map(decision.decisions.map((entry) => [entry.capability, entry.decision]));
  assert.equal(decisions.get('local-skill:terraform-review'), 'admit');
  assert.equal(decisions.get('local-mcp-resource:queue-review'), 'admit');
  assert.equal(decisions.get('incoming-skill:repository-operator'), 'reject');
  assert.equal(decisions.get('incoming-server:anywhere-mcp'), 'reject');
  assert.deepEqual(decision.rejectedServerReasons, [
    'unpinned-startup',
    'broad-authority',
    'mutating-tool-mislabeled-read-only',
  ]);
  assert.deepEqual(decision.enforcement, {
    skillAllowedToolsIsPermissionBoundary: false,
    mcpAnnotationsArePermissionBoundary: false,
    serverIdentityProvesTrust: false,
    enforcedBy: ['fixed-argv-runner', 'operating-system-boundary', 'human-approval'],
  });
  assert.equal(decision.humanApprovalRequired, true);
});

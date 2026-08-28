import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const labRoot = resolve(import.meta.dirname, '../../..');
const launcher = resolve(labRoot, 'labs/m9/check-section-9.mjs');
const section = resolve(labRoot, 'section-9');

function run(checker, source, output) {
  return spawnSync(process.execPath, [checker, source, output], {encoding: 'utf8', timeout: 180_000});
}

async function temporaryLab() {
  const parent = await mkdtemp(join(tmpdir(), 'section-9-trust-anchor-'));
  await cp(resolve(labRoot, 'section-9'), join(parent, 'section-9'), {recursive: true});
  await mkdir(join(parent, 'labs'), {recursive: true});
  await cp(resolve(labRoot, 'labs/m9'), join(parent, 'labs/m9'), {recursive: true});
  return {parent, source: join(parent, 'section-9'), checker: join(parent, 'labs/m9/check-section-9.mjs')};
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function rehashManifest({parent, source, checker}) {
  const path = join(resolve(checker, '..'), 'protected-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const target of Object.keys(manifest.protected_files)) {
    const targetPath = target.startsWith('section-9/')
      ? join(source, target.slice('section-9/'.length))
      : join(parent, target);
    manifest.protected_files[target] = sha256(await readFile(targetPath));
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('trusted launcher records the external manifest and scope boundary', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-9-trusted-run-'));
  const output = join(parent, 'agentic-iac-section-9-trusted-starter');
  try {
    const result = run(launcher, section, output);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(output, 'evidence-report.json'), 'utf8'));
    assert.equal(report.trust_boundary.kind, 'external-author-launcher-plus-git-and-human-review');
    assert.equal(report.trust_boundary.launcher, 'labs/m9/check-section-9.mjs');
    assert.match(report.trust_boundary.manifest_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.trust_boundary.scope_sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.trust_boundary.cryptographic_self_attestation, false);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('learner evaluator refuses a direct invocation without the trust anchor', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'section-9-direct-evaluator-'));
  const output = join(parent, 'agentic-iac-section-9-direct');
  try {
    const evaluator = resolve(section, 'scripts/check-package.mjs');
    const result = run(evaluator, section, output);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /use the trusted launcher labs\/m9\/check-section-9\.mjs/i);
    await assert.rejects(access(output));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('launcher rejects evaluator, manifest target, protected doc, and scope mutations', async (t) => {
  const cases = [
    ['evaluator', async ({source}) => {
      const path = join(source, 'scripts/check-package.mjs');
      await writeFile(path, `${await readFile(path, 'utf8')}\n// changed evaluator\n`);
    }],
    ['manifest target', async ({checker}) => {
      const path = join(resolve(checker, '..'), 'protected-manifest.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.protected_files['section-9/scripts/check-package-copy.mjs'] = manifest.protected_files['section-9/scripts/check-package.mjs'];
      delete manifest.protected_files['section-9/scripts/check-package.mjs'];
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }],
    ['protected doc', async ({source}) => {
      const path = join(source, 'task.md');
      await writeFile(path, `${await readFile(path, 'utf8')}\nChanged learner scope.\n`);
    }],
    ['evaluated scope', async ({checker}) => {
      const path = join(resolve(checker, '..'), 'evaluator-scope.json');
      const scope = JSON.parse(await readFile(path, 'utf8'));
      scope.learner_owned_files.push('chart/templates/service.yaml');
      await writeFile(path, `${JSON.stringify(scope, null, 2)}\n`);
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const lab = await temporaryLab();
      const output = join(lab.parent, `agentic-iac-section-9-${name.replaceAll(' ', '-')}`);
      try {
        await mutate(lab);
        const result = run(lab.checker, lab.source, output);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /protected (file hash mismatch|manifest target set|scope hash mismatch)/i);
        await assert.rejects(access(output));
      } finally {
        await rm(lab.parent, {recursive: true, force: true});
      }
    });
  }
});

test('trusted evaluation still rejects an empty render after an author-approved manifest refresh', async () => {
  const lab = await temporaryLab();
  const output = join(lab.parent, 'agentic-iac-section-9-empty-render');
  try {
    for (const file of ['deployment.yaml', 'configmap.yaml', 'networkpolicy.yaml', 'service.yaml', 'serviceaccount.yaml']) {
      await writeFile(join(lab.source, 'chart/templates', file), '{{- if false }}{{- end }}\n');
    }
    await rehashManifest(lab);
    const result = run(lab.checker, lab.source, output);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /empty render/i);
    await assert.rejects(access(output));
  } finally {
    await rm(lab.parent, {recursive: true, force: true});
  }
});

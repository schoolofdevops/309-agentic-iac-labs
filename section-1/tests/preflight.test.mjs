import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/preflight.sh', import.meta.url));
const source = readFileSync(script, 'utf8');

assert.match(source, /git --version/, 'the preflight must verify Git');
assert.match(source, /terraform version/, 'the preflight must verify Terraform');
assert.match(source, /tofu version/, 'the preflight must verify OpenTofu');
assert.match(source, /docker version/, 'the preflight must check Docker without starting a workload');
assert.match(source, /7 GB/, 'the learner baseline must be visible');
assert.doesNotMatch(source, /docker run|docker compose up|terraform apply|tofu apply/, 'the preflight must not start workloads or apply infrastructure');

const fakeBin = mkdtempSync(join(tmpdir(), 'm1-preflight-bin-'));
const fakeTool = join(fakeBin, 'fake-tool');
writeFileSync(fakeTool, `#!/usr/bin/env bash
case "$(basename "$0")" in
  git) printf 'git version test\n' ;;
  docker) printf 'Docker server test\n' ;;
  terraform)
    for i in $(seq 1 20000); do printf 'Terraform vtest line %s\n' "$i"; done
    ;;
  tofu) printf 'OpenTofu vtest\nmore output\n' ;;
esac
`);
chmodSync(fakeTool, 0o755);
for (const name of ['git', 'docker', 'terraform', 'tofu']) symlinkSync(fakeTool, join(fakeBin, name));

try {
  const run = spawnSync(script, [], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {...process.env, PATH: `${fakeBin}:${process.env.PATH}`},
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `preflight must tolerate multi-line version output\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /OpenTofu vtest/);
  assert.match(run.stdout, /PASS     preflight complete/);
} finally {
  rmSync(fakeBin, {recursive: true, force: true});
}

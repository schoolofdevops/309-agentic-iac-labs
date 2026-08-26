import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/preflight.sh', import.meta.url));
const source = readFileSync(script, 'utf8');

assert.doesNotMatch(source, /docker run|docker compose up|terraform apply|tofu apply/, 'preflight must not start workloads or apply infrastructure');

const fakeBin = mkdtempSync(join(tmpdir(), 'm1-preflight-bin-'));
const fakeTool = join(fakeBin, 'fake-tool');
writeFileSync(fakeTool, `#!/usr/bin/env bash
case "$(basename "$0")" in
  uname) printf 'Darwin\n' ;;
  sysctl)
    case "$*" in
      *hw.memsize*) printf '%s\n' $((4 * 1024 * 1024 * 1024)) ;;
      *hw.logicalcpu*) printf '2\n' ;;
    esac
    ;;
  df) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfake 10000000 9000000 1048576 90%% /\n' ;;
  git) printf 'git version test\n' ;;
  docker) printf 'Docker server test\n' ;;
  terraform) printf 'Terraform vtest\n' ;;
  tofu) printf 'OpenTofu vtest\n' ;;
  codex) printf 'codex-cli test\n' ;;
esac
`);
chmodSync(fakeTool, 0o755);
for (const name of ['uname', 'sysctl', 'df', 'git', 'docker', 'terraform', 'tofu', 'codex']) {
  symlinkSync(fakeTool, join(fakeBin, name));
}

try {
  const run = spawnSync(script, [], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {...process.env, PATH: `${fakeBin}:/usr/bin:/bin`},
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, `low resources and missing agents must not block Section 1\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /WARN\s+RAM .*below the tested 7 GB baseline/);
  assert.match(run.stdout, /WARN\s+CPU .*below the tested 4-CPU baseline/);
  assert.match(run.stdout, /WARN\s+Disk .*below the tested 20 GB baseline/);
  assert.match(run.stdout, /AVAILABLE\s+Codex\s+codex-cli test/);
  assert.match(run.stdout, /NOT FOUND\s+Claude Code/);
  assert.match(run.stdout, /READY\s+Preflight report complete/);
} finally {
  rmSync(fakeBin, {recursive: true, force: true});
}

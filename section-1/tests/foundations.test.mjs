import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scenarios = JSON.parse(readFileSync(new URL('../scenarios/autonomy-actions.json', import.meta.url), 'utf8'));
assert.equal(scenarios.length, 8);
assert.equal(new Set(scenarios.map((item) => item.id)).size, scenarios.length, 'scenario IDs must be unique');

const checker = readFileSync(new URL('../scripts/check-foundations.mjs', import.meta.url), 'utf8');
for (const required of ['allowed_files', 'allowed_tools', 'forbidden_actions', 'required_evidence', 'stop_conditions', 'human_approval_required_for']) {
  assert.match(checker, new RegExp(required), `checker must validate ${required}`);
}
assert.match(checker, /Terraform validation evidence/);
assert.match(checker, /OpenTofu validation evidence/);

const root = fileURLToPath(new URL('../..', import.meta.url));
const run = spawnSync('node', [
  `${root}/section-1/scripts/check-foundations.mjs`,
  `${root}/section-1/tests/fixtures/autonomy-classification.solution.json`,
  `${root}/section-1/tests/fixtures/safe-task-brief.solution.json`,
], {cwd: root, encoding: 'utf8'});
assert.equal(run.status, 0, run.stderr);
assert.match(run.stdout, /Section 1 foundation checkpoint complete/);

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const classificationsPath = process.argv[2] ?? 'section-1/answers/autonomy-classification.json';
const briefPath = process.argv[3] ?? 'section-1/challenge/safe-task-brief.json';
const classifications = JSON.parse(readFileSync(classificationsPath, 'utf8'));
const expected = new Map([
  ['manual-plan-review', 'L0'],
  ['provider-suggestion', 'L1'],
  ['read-only-plan', 'L2'],
  ['bounded-repair', 'L3'],
  ['approved-apply', 'L4'],
  ['scheduled-observer', 'L5'],
  ['unapproved-delete', 'REJECT'],
  ['broad-credentials', 'REJECT'],
]);

assert.equal(classifications.length, expected.size, 'classify every scenario');
for (const answer of classifications) {
  assert.equal(answer.classification, expected.get(answer.id), `${answer.id}: choose L0-L5 or REJECT`);
  assert.ok(answer.reason && answer.reason !== 'TODO' && answer.reason.length >= 12, `${answer.id}: add a short engineering reason`);
}
console.log('PASS     autonomy classifications are complete');

const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
assert.ok(brief.objective && brief.objective !== 'TODO', 'define a bounded objective');
for (const field of ['allowed_files', 'allowed_tools', 'forbidden_actions', 'required_evidence', 'stop_conditions', 'human_approval_required_for']) {
  assert.ok(Array.isArray(brief[field]) && brief[field].length > 0, `${field} must contain at least one item`);
}

const forbidden = brief.forbidden_actions.join(' ').toLowerCase();
assert.match(forbidden, /apply/, 'forbid apply during the repair task');
assert.match(forbidden, /state/, 'forbid Terraform/OpenTofu state commands');
assert.match(forbidden, /delete|destroy/, 'forbid unapproved deletion or destroy');

const evidence = brief.required_evidence.join(' ').toLowerCase();
assert.match(evidence, /diff/, 'require a diff');
assert.match(evidence, /terraform/, 'require Terraform validation evidence');
assert.match(evidence, /tofu|opentofu/, 'require OpenTofu validation evidence');

const approvals = brief.human_approval_required_for.join(' ').toLowerCase();
assert.match(approvals, /apply|state|destroy|delete/, 'place state-changing work behind human approval');

console.log('PASS     safe task brief contains scope, evidence, stop, and approval controls');
console.log('PASS     Section 1 foundation checkpoint complete');

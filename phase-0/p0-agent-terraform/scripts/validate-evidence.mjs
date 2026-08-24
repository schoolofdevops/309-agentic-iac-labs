import { readFileSync } from 'node:fs';

const allowedKinds = new Set([
  'task',
  'source',
  'claim',
  'artifact',
  'evaluation',
  'observation',
  'commit',
]);

const allowedPredicates = new Set([
  'DEPENDS_ON',
  'SUPPORTS',
  'CONTRADICTS',
  'DERIVED_FROM',
  'PRODUCED',
  'EVALUATES',
  'REVISES',
  'PARENT_OF',
]);

const idPattern = /^[a-z][a-z0-9-]{2,63}$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function validateRecord(record) {
  for (const field of ['id', 'kind', 'source', 'authoring_run', 'version']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      return `missing required string: ${field}`;
    }
  }

  if (!idPattern.test(record.id)) return 'invalid record id';
  if (!allowedKinds.has(record.kind)) return 'invalid record kind';

  if (record.relations === undefined) return null;
  if (!Array.isArray(record.relations)) return 'relations must be an array';

  for (const relation of record.relations) {
    if (!relation || typeof relation !== 'object') return 'relation must be an object';
    if (!allowedPredicates.has(relation.predicate)) return 'invalid relation predicate';
    if (typeof relation.target !== 'string' || !idPattern.test(relation.target)) {
      return 'invalid relation target';
    }
    if (typeof relation.source !== 'string' || relation.source.length === 0) {
      return 'missing relation source';
    }
  }

  return null;
}

const input = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : readFileSync(0, 'utf8');

let record;
try {
  record = JSON.parse(input);
} catch {
  fail('input must be valid JSON');
}

const error = validateRecord(record);
if (error) fail(error);
process.stdout.write(`valid evidence record: ${record.id}\n`);

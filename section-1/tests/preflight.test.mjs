import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/preflight.sh', import.meta.url));
const source = readFileSync(script, 'utf8');

assert.match(source, /git --version/, 'the preflight must verify Git');
assert.match(source, /terraform version/, 'the preflight must verify Terraform');
assert.match(source, /tofu version/, 'the preflight must verify OpenTofu');
assert.match(source, /docker version/, 'the preflight must check Docker without starting a workload');
assert.match(source, /7 GB/, 'the learner baseline must be visible');
assert.doesNotMatch(source, /docker run|docker compose up|terraform apply|tofu apply/, 'the preflight must not start workloads or apply infrastructure');

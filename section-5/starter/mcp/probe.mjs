#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const protocol = '2026-07-28';
const resourceUri = 'iac://course/queue-review';
const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const source = fileURLToPath(new URL('../../fixture/queue-context.md', import.meta.url));
const terraformFixture = fileURLToPath(new URL('../../fixture/main.tf', import.meta.url));
const sourceText = readFileSync(source, 'utf8');
const sourceHash = createHash('sha256').update(sourceText).digest('hex');
const terraformText = readFileSync(terraformFixture, 'utf8');
const terraformHash = createHash('sha256').update(terraformText).digest('hex');

function request(id, method, fields = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...fields,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'course-model-free-probe', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

const requests = [
  request(1, 'server/discover'),
  request(2, 'resources/list'),
  request(3, 'resources/read', { uri: resourceUri }),
  request(4, 'resources/read', { uri: 'iac://course/not-approved' }),
  { jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} },
  request(6, 'tools/list'),
];

const result = spawnSync(process.execPath, [server], {
  encoding: 'utf8',
  input: `${requests.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  timeout: 10000,
  env: { ...process.env, CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1' },
});

assert.equal(result.status, 0, result.stderr || 'MCP server failed');
assert.equal(result.stderr, '');
const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
assert.equal(replies.length, 6);

const discovery = replies[0].result;
assert.deepEqual(discovery.supportedVersions, [protocol]);
assert.deepEqual(discovery.capabilities, { resources: {} });
assert.equal(Object.hasOwn(discovery.capabilities, 'tools'), false);
assert.equal(Object.hasOwn(discovery.capabilities, 'prompts'), false);
assert.equal(discovery.resultType, 'complete');
assert.equal(discovery.ttlMs, 0);
assert.equal(discovery.cacheScope, 'private');

const resources = replies[1].result.resources;
assert.equal(resources.length, 1);
assert.equal(resources[0].uri, resourceUri);

const content = replies[2].result.contents[0];
assert.equal(content.uri, resourceUri);
assert.equal(content.text, sourceText);
assert.equal(content._meta['course.agentic-iac/sha256'], sourceHash);
assert.equal(content._meta['course.agentic-iac/bytes'], Buffer.byteLength(sourceText));

assert.equal(replies[3].error.code, -32602);
assert.equal(replies[4].error.code, -32602);
assert.equal(replies[5].error.code, -32601);
assert.equal(createHash('sha256').update(readFileSync(source, 'utf8')).digest('hex'), sourceHash);
assert.equal(createHash('sha256').update(readFileSync(terraformFixture, 'utf8')).digest('hex'), terraformHash);

process.stdout.write('MCP resource probe: PASS\n');
process.stdout.write(`Protocol: ${protocol}\n`);
process.stdout.write(`Resources: ${resources.length}\n`);
process.stdout.write(`Resource bytes: ${Buffer.byteLength(sourceText)}\n`);
process.stdout.write(`Resource SHA256: ${sourceHash}\n`);
process.stdout.write('Tools capability: absent\n');
process.stdout.write('Unknown resource URI: rejected with -32602\n');
process.stdout.write('Missing request metadata: rejected with -32602\n');
process.stdout.write('Unknown method: rejected with -32601\n');

#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE_URI = 'iac://course/queue-review';
const sourcePath = fileURLToPath(new URL('../../fixture/queue-context.md', import.meta.url));
const serverInfo = { name: 'course-queue-context', version: '1.0.0' };

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function responseMeta() {
  return { 'io.modelcontextprotocol/serverInfo': serverInfo };
}

function completeResult(fields) {
  return {
    ...fields,
    resultType: 'complete',
    ttlMs: 0,
    cacheScope: 'private',
    _meta: responseMeta(),
  };
}

function validateRequestMeta(request) {
  const meta = request?.params?._meta;
  return (
    meta?.['io.modelcontextprotocol/protocolVersion'] === PROTOCOL_VERSION &&
    typeof meta?.['io.modelcontextprotocol/clientInfo']?.name === 'string' &&
    typeof meta?.['io.modelcontextprotocol/clientInfo']?.version === 'string' &&
    meta?.['io.modelcontextprotocol/clientCapabilities'] !== null &&
    typeof meta?.['io.modelcontextprotocol/clientCapabilities'] === 'object'
  );
}

function handle(request) {
  if (request?.jsonrpc !== '2.0' || request.id === undefined || typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (!validateRequestMeta(request)) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: 'Required 2026-07-28 request metadata is missing or invalid' },
    };
  }

  if (request.method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: completeResult({
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { resources: {} },
        instructions: 'Provides one reviewed queue-context resource. It grants no command or approval authority.',
      }),
    };
  }

  if (request.method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: completeResult({
        resources: [
          {
            uri: RESOURCE_URI,
            name: 'Reviewed queue context',
            description: 'Source-linked context from the Section 4 queue review.',
            mimeType: 'text/markdown',
          },
        ],
      }),
    };
  }

  if (request.method === 'resources/read') {
    if (request.params?.uri !== RESOURCE_URI) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'Unknown or unapproved resource URI' },
      };
    }
    const text = readFileSync(sourcePath, 'utf8');
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: completeResult({
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: 'text/markdown',
            text,
            _meta: {
              'course.agentic-iac/source': 'section-5/fixture/queue-context.md',
              'course.agentic-iac/sha256': sha256(text),
              'course.agentic-iac/bytes': Buffer.byteLength(text),
            },
          },
        ],
      }),
    };
  }

  return {
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: 'Method not found' },
  };
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let reply;
  try {
    reply = handle(JSON.parse(line));
  } catch {
    reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

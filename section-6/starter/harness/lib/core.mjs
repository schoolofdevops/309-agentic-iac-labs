import {createHash} from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const sectionRoot = path.resolve(import.meta.dirname, '..', '..', '..');

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fileSha256(filePath) {
  return sha256(readFileSync(filePath));
}

export function resolveInside(root, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative`);
  }
  const resolved = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`${label} escapes its allowed root`);
  }
  return resolved;
}

export function prepareOutput(outputPath) {
  if (!path.isAbsolute(outputPath)) {
    throw new Error('output must be an absolute path');
  }
  const allowedRoots = [...new Set([realpathSync(tmpdir()), realpathSync('/tmp')])];
  const resolved = path.resolve(outputPath);
  const parent = realpathSync(path.dirname(resolved));
  const insideTemporaryRoot = allowedRoots.some(
    (allowedRoot) => parent === allowedRoot || parent.startsWith(`${allowedRoot}${path.sep}`),
  );
  if (!insideTemporaryRoot) {
    throw new Error('output must stay below the operating-system temporary directory');
  }
  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error('output must not be a symbolic link');
    }
    if (!statSync(resolved).isDirectory() || readdirSync(resolved).length > 0) {
      throw new Error('output must be a new or empty directory');
    }
  } else {
    mkdirSync(resolved);
  }
  return realpathSync(resolved);
}

export function snapshotSource(root) {
  const result = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === '.terraform') continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.set(relative, fileSha256(full));
    }
  };
  visit(root);
  return result;
}

export function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

export function applyOperations(workspace, operations) {
  for (const operation of operations) {
    const target = resolveInside(workspace, operation.path, 'operation path');
    if (operation.type === 'replace') {
      const current = readFileSync(target, 'utf8');
      if (typeof operation.find !== 'string' || !current.includes(operation.find)) {
        throw new Error(`replace text not found in ${operation.path}`);
      }
      const first = current.indexOf(operation.find);
      if (current.indexOf(operation.find, first + operation.find.length) !== -1) {
        throw new Error(`replace text is not unique in ${operation.path}`);
      }
      writeFileSync(
        target,
        `${current.slice(0, first)}${operation.replace}${current.slice(first + operation.find.length)}`,
      );
    } else if (operation.type === 'write') {
      mkdirSync(path.dirname(target), {recursive: true});
      writeFileSync(target, operation.content, {flag: 'wx'});
    } else {
      throw new Error(`unsupported operation type: ${operation.type}`);
    }
  }
}

export function loadContext(contextPaths) {
  const chunks = [];
  for (const relativePath of contextPaths) {
    if (!relativePath.startsWith('context/')) {
      throw new Error('context path must stay below context/');
    }
    const full = resolveInside(sectionRoot, relativePath, 'context path');
    chunks.push({path: relativePath, bytes: readFileSync(full)});
  }
  return chunks;
}

export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

export function redactText(value) {
  let redactions = 0;
  const text = value
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, (_match, label) => {
      redactions += 1;
      return `${label}=[REDACTED]`;
    })
    .replace(/\bBearer\s+\S+/gi, () => {
      redactions += 1;
      return 'Bearer [REDACTED]';
    });
  return {text, redactions};
}

export function runCommand(engine, args, cwd, timeoutMs = 30_000) {
  const childEnvironment = {
    PATH: process.env.PATH ?? '',
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    CHECKPOINT_DISABLE: '1',
    HOME: tmpdir(),
    TMPDIR: tmpdir(),
  };
  const started = process.hrtime.bigint();
  const result = spawnSync(engine, args, {
    cwd,
    encoding: 'utf8',
    env: childEnvironment,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const stdout = redactText(result.stdout ?? '');
  const stderr = redactText(result.stderr ?? result.error?.message ?? '');
  return {
    argv: [engine, ...args],
    exit_code: result.status,
    signal: result.signal,
    timed_out: result.error?.code === 'ETIMEDOUT',
    duration_ms: Number(durationMs.toFixed(2)),
    stdout: stdout.text,
    stderr: stderr.text,
    redactions: stdout.redactions + stderr.redactions,
  };
}

export function deriveSummary(mainTf) {
  const defaultMatch = mainTf.match(/default\s*=\s*"([^"]+)"/);
  const nullableMatch = mainTf.match(/nullable\s*=\s*(true|false)/);
  if (!defaultMatch || !nullableMatch) return null;
  return `queue_name=${defaultMatch[1]};nullable=${nullableMatch[1]}`;
}

export function copyFixture(workspace) {
  cpSync(path.join(sectionRoot, 'fixture', 'main.tf'), path.join(workspace, 'main.tf'));
}

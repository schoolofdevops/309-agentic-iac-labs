#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const TASK_ID = "section-10-task-4";
const REPOSITORY_NAME = "delivery.git";
const MARKER_NAME = ".agentic-iac-s10-git-mirror.json";
const GIT = "/usr/bin/git";

class FixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reject(code, message) {
  throw new FixtureError(code, message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) reject("USAGE", `missing ${name}`);
  return process.argv[index + 1];
}

function gitEnvironment() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: realpathSync(tmpdir()),
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

function git(args, cwd, accepted = [0]) {
  const result = spawnSync(GIT, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: gitEnvironment(),
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (!accepted.includes(result.status)) {
    reject("GIT_COMMAND_FAILED", result.error?.message ?? result.stderr ?? result.stdout);
  }
  return result.stdout.trim();
}

function assertNoSymlinkAncestor(path) {
  const temp = resolve(tmpdir());
  let cursor = resolve(path);
  while (cursor.startsWith(`${temp}${sep}`) && cursor !== temp) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      reject("SYMLINK_ANCESTOR", cursor);
    }
    cursor = dirname(cursor);
  }
}

function validateNewRoot(input) {
  const requested = resolve(input);
  const temp = realpathSync(tmpdir());
  assertNoSymlinkAncestor(requested);
  if (realpathSync(dirname(requested)) !== temp || !basename(requested).startsWith("agentic-iac-s10-")) {
    reject("ROOT_OUTSIDE_TEMP", "root must be a new direct child of the operating-system temporary directory with prefix agentic-iac-s10-");
  }
  const root = join(temp, basename(requested));
  if (existsSync(root)) reject("ROOT_ALREADY_EXISTS", root);
  return root;
}

function validateSource(input, revision) {
  const requested = resolve(input);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) reject("SOURCE_INVALID", requested);
  if (lstatSync(requested).isSymbolicLink()) reject("SOURCE_SYMLINK", requested);
  const source = realpathSync(requested);
  const inside = git(["rev-parse", "--is-inside-work-tree"], source);
  if (inside !== "true") reject("SOURCE_NOT_GIT", source);
  if (!/^[0-9a-f]{40}$/.test(revision)) reject("REVISION_INVALID", "revision must be a full lowercase commit SHA");
  const head = git(["rev-parse", "HEAD"], source);
  if (revision !== head) reject("REVISION_NOT_HEAD", "approved revision must equal the clean working tree HEAD");
  const type = git(["cat-file", "-t", revision], source);
  if (type !== "commit") reject("REVISION_INVALID", "revision is not a commit");
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], source);
  if (dirty) reject("SOURCE_NOT_CLEAN", dirty);
  return source;
}

function makeReadOnly(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) reject("MIRROR_SYMLINK", child);
    if (entry.isDirectory()) {
      makeReadOnly(child);
      chmodSync(child, 0o755);
    } else {
      chmodSync(child, 0o444);
    }
  }
}

try {
  const sourceInput = argument("--source");
  const revision = argument("--revision");
  const root = validateNewRoot(argument("--root"));
  const source = validateSource(sourceInput, revision);
  const repository = join(root, REPOSITORY_NAME);
  mkdirSync(root, { mode: 0o700 });
  try {
    git(["init", "--bare", "--initial-branch=main", repository], root);
    git(["--git-dir", repository, "fetch", "--no-tags", "--force", "--no-write-fetch-head", source, `${revision}:refs/heads/main`], root);
    const mirrored = git(["--git-dir", repository, "rev-parse", "refs/heads/main"], root);
    if (mirrored !== revision) reject("MIRROR_REVISION_MISMATCH", `${mirrored} != ${revision}`);
    rmSync(join(repository, "hooks"), { recursive: true, force: true });
    rmSync(join(repository, "FETCH_HEAD"), { force: true });
    if (existsSync(join(repository, "git-daemon-export-ok"))) rmSync(join(repository, "git-daemon-export-ok"));
    const config = readFileSync(join(repository, "config"), "utf8");
    if (/credential|receivepack|\burl\s*=|learner|token/i.test(config)) reject("MIRROR_CONFIG_UNSAFE", config);
    makeReadOnly(repository);
    const marker = {
      marker_version: 1,
      task_id: TASK_ID,
      root,
      repository_name: REPOSITORY_NAME,
      source_revision: revision,
      transport_scope: "anonymous local course transport; not production authentication or authorization",
    };
    writeFileSync(join(root, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o400, flag: "wx" });
    process.stdout.write(`${JSON.stringify(marker)}\n`);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
} catch (error) {
  const code = error instanceof FixtureError ? error.code : "UNEXPECTED";
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exitCode = 1;
}

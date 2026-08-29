#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const TASK_ID = "section-10-task-4";
export const REPOSITORY_NAME = "delivery.git";
export const MARKER_NAME = ".agentic-iac-s10-git-mirror.json";
export const READY_NAME = "git-mirror-ready.json";
export const TRANSPORT_SCOPE = "anonymous local course transport; not production authentication or authorization";
const MARKER_KEYS = ["marker_version", "owner_uid", "repository_file_count", "repository_manifest_sha256", "repository_name", "root", "source_revision", "state", "task_id", "transport_scope"].sort();
const READY_KEYS = ["container_id", "container_name", "endpoint", "prepared_marker_sha256", "record_version", "repository_manifest_sha256", "repository_name", "source_revision", "state", "task_id", "transport_scope"].sort();

export class FixtureError extends Error { constructor(code, message) { super(message); this.code = code; } }
export function reject(code, message) { throw new FixtureError(code, message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function currentUid() { return typeof process.getuid === "function" ? process.getuid() : statSync(realpathSync(tmpdir())).uid; }
let resolvedGit;

export function parseCliArgs(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!allowed.includes(name)) reject("UNKNOWN_ARGUMENT", String(name));
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) reject("USAGE", `missing value for ${name}`);
    if (Object.hasOwn(values, name)) reject("DUPLICATE_ARGUMENT", name);
    values[name] = argv[index + 1];
  }
  for (const name of allowed) if (!Object.hasOwn(values, name)) reject("USAGE", `missing ${name}`);
  return values;
}

function gitEnvironment() {
  return {
    GIT_ALLOW_PROTOCOL: "file", GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EXTERNAL_DIFF: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat", GIT_PROTOCOL_FROM_USER: "0", GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_TERMINAL_PROMPT: "0", HOME: realpathSync(tmpdir()), LANG: "C", LC_ALL: "C",
    PAGER: "cat", PATH: "/usr/bin:/bin",
  };
}
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
  "-c", "diff.external=", "-c", "protocol.file.allow=always", "-c", "uploadpack.allowFilter=false",
  "-c", "uploadpack.allowAnySHA1InWant=false",
];
export function trustedGit(args, cwd, accepted = [0]) {
  if (!resolvedGit) {
    for (const candidate of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
      if (!existsSync(candidate)) continue;
      const canonical = realpathSync(candidate);
      const stats = lstatSync(canonical);
      if (!stats.isFile() || (stats.mode & 0o111) === 0 || (stats.mode & 0o022) !== 0 || ![0, currentUid()].includes(stats.uid)) continue;
      const version = spawnSync(canonical, ["--version"], { encoding: "utf8", shell: false, env: gitEnvironment(), timeout: 10_000 });
      if (version.status === 0 && /^git version \d+\.\d+/.test(version.stdout)) { resolvedGit = canonical; break; }
    }
    if (!resolvedGit) reject("TRUSTED_TOOL_MISSING", "git");
  }
  const result = spawnSync(resolvedGit, [...SAFE_GIT_CONFIG, ...args], { cwd, encoding: "utf8", shell: false, env: gitEnvironment(), timeout: 60_000, killSignal: "SIGKILL" });
  if (!accepted.includes(result.status)) reject("GIT_COMMAND_FAILED", result.error?.message ?? result.stderr ?? result.stdout);
  return result;
}

function assertNoSymlinkAncestor(path) {
  const temp = resolve(tmpdir());
  let cursor = resolve(path);
  while (cursor.startsWith(`${temp}${sep}`) && cursor !== temp) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) reject("SYMLINK_ANCESTOR", cursor);
    cursor = dirname(cursor);
  }
}
function canonicalNewRoot(input) {
  const requested = resolve(input);
  const temp = realpathSync(tmpdir());
  assertNoSymlinkAncestor(requested);
  if (realpathSync(dirname(requested)) !== temp || !basename(requested).startsWith("agentic-iac-s10-")) reject("ROOT_OUTSIDE_TEMP", requested);
  const root = join(temp, basename(requested));
  if (existsSync(root)) reject("ROOT_ALREADY_EXISTS", root);
  return root;
}
function canonicalExistingRoot(input) {
  const requested = resolve(input);
  const temp = realpathSync(tmpdir());
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) reject("ROOT_OUTSIDE_TEMP", requested);
  const root = realpathSync(requested);
  const stats = lstatSync(root);
  if (dirname(root) !== temp || !basename(root).startsWith("agentic-iac-s10-") || !stats.isDirectory() || stats.uid !== currentUid() || (stats.mode & 0o022) !== 0) reject("ROOT_OUTSIDE_TEMP", requested);
  return root;
}
function validateSource(input, revision) {
  const requested = resolve(input);
  if (!existsSync(requested) || !statSync(requested).isDirectory() || lstatSync(requested).isSymbolicLink()) reject("SOURCE_INVALID", requested);
  const source = realpathSync(requested);
  if (trustedGit(["rev-parse", "--is-inside-work-tree"], source).stdout.trim() !== "true") reject("SOURCE_NOT_GIT", source);
  if (!/^[0-9a-f]{40}$/.test(revision)) reject("REVISION_INVALID", "revision must be a full lowercase commit SHA");
  if (trustedGit(["rev-parse", "HEAD"], source).stdout.trim() !== revision) reject("REVISION_NOT_HEAD", "approved revision must equal clean HEAD");
  if (trustedGit(["cat-file", "-t", revision], source).stdout.trim() !== "commit") reject("REVISION_INVALID", revision);
  const dirty = trustedGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], source).stdout.trim();
  if (dirty) reject("SOURCE_NOT_CLEAN", dirty);
  return source;
}
function makeReadable(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) reject("MIRROR_SYMLINK", child);
    if (entry.isDirectory()) { makeReadable(child); chmodSync(child, 0o755); }
    else chmodSync(child, 0o444);
  }
}
function repositoryManifest(repository) {
  const entries = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const name = relative(repository, path).replaceAll("\\", "/");
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) reject("MIRROR_SYMLINK", name);
      if (stats.isDirectory()) { entries.push({ name: `${name}/`, type: "directory", mode: stats.mode & 0o777 }); visit(path); }
      else if (stats.isFile()) entries.push({ name, type: "file", mode: stats.mode & 0o777, sha256: sha256(readFileSync(path)) });
      else reject("MIRROR_TYPE_INVALID", name);
    }
  }
  visit(repository);
  return { file_count: entries.filter((entry) => entry.type === "file").length, sha256: sha256(JSON.stringify(entries)) };
}
function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) reject(code, "unexpected record schema");
}
function readOwnedJson(path, code) {
  if (!existsSync(path)) reject(code, path);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid() || (stats.mode & 0o022) !== 0) reject(code, path);
  const bytes = readFileSync(path);
  try { return { value: JSON.parse(bytes), bytes }; } catch (error) { reject(code, error.message); }
}
function validateRepository(repository, revision, expectedManifest) {
  if (!existsSync(repository) || lstatSync(repository).isSymbolicLink() || !lstatSync(repository).isDirectory() || realpathSync(repository) !== repository) reject("MIRROR_INVALID", repository);
  if (readFileSync(join(repository, "HEAD"), "utf8") !== "ref: refs/heads/main\n") reject("MIRROR_REF_MISMATCH", "HEAD");
  const refs = trustedGit(["--git-dir", repository, "show-ref"], dirname(repository)).stdout.trim().split("\n").filter(Boolean);
  if (JSON.stringify(refs) !== JSON.stringify([`${revision} refs/heads/main`])) reject("MIRROR_REF_MISMATCH", refs.join("\n"));
  if (trustedGit(["--git-dir", repository, "cat-file", "-t", revision], dirname(repository)).stdout.trim() !== "commit") reject("MIRROR_OBJECT_MISMATCH", revision);
  trustedGit(["--git-dir", repository, "fsck", "--strict", "--no-dangling"], dirname(repository));
  const manifest = repositoryManifest(repository);
  if (manifest.sha256 !== expectedManifest.sha256 || manifest.file_count !== expectedManifest.file_count) reject("MIRROR_CONTENT_MISMATCH", "repository inventory changed");
  return manifest;
}

export function loadMirrorState(rootInput, { require = "AUTO" } = {}) {
  const root = canonicalExistingRoot(rootInput);
  const markerRecord = readOwnedJson(join(root, MARKER_NAME), "OWNERSHIP_MARKER");
  const marker = markerRecord.value;
  exactKeys(marker, MARKER_KEYS, "OWNERSHIP_MARKER");
  if (marker.marker_version !== 1 || marker.state !== "PREPARED" || marker.task_id !== TASK_ID || marker.owner_uid !== currentUid() || marker.root !== root || marker.repository_name !== REPOSITORY_NAME || !/^[0-9a-f]{40}$/.test(marker.source_revision ?? "") || !/^[0-9a-f]{64}$/.test(marker.repository_manifest_sha256 ?? "") || !Number.isInteger(marker.repository_file_count) || marker.transport_scope !== TRANSPORT_SCOPE) reject("OWNERSHIP_MARKER", "marker fields are inconsistent");
  const readyExists = existsSync(join(root, READY_NAME));
  const lifecycle = readyExists ? "READY" : "PREPARED";
  if (require !== "AUTO" && lifecycle !== require) reject("LIFECYCLE_STATE_MISMATCH", `${lifecycle} != ${require}`);
  const expectedRoot = readyExists ? [MARKER_NAME, READY_NAME, REPOSITORY_NAME] : [MARKER_NAME, REPOSITORY_NAME];
  const inventory = readdirSync(root).sort();
  if (JSON.stringify(inventory) !== JSON.stringify(expectedRoot.sort())) reject("ROOT_INVENTORY_MISMATCH", JSON.stringify(inventory));
  const repository = join(root, REPOSITORY_NAME);
  validateRepository(repository, marker.source_revision, { sha256: marker.repository_manifest_sha256, file_count: marker.repository_file_count });
  let ready;
  if (readyExists) {
    const readyRecord = readOwnedJson(join(root, READY_NAME), "READY_RECORD_INVALID");
    ready = readyRecord.value;
    exactKeys(ready, READY_KEYS, "READY_RECORD_INVALID");
    if (ready.record_version !== 1 || ready.state !== "READY" || ready.task_id !== TASK_ID || ready.container_name !== "agentic-iac-s10-git" || !/^[0-9a-f]{64}$/.test(ready.container_id ?? "") || ready.repository_name !== REPOSITORY_NAME || ready.source_revision !== marker.source_revision || ready.repository_manifest_sha256 !== marker.repository_manifest_sha256 || ready.prepared_marker_sha256 !== sha256(markerRecord.bytes) || ready.transport_scope !== TRANSPORT_SCOPE || !/^git:\/\/[^/:]+:9418\/delivery\.git$/.test(ready.endpoint ?? "")) reject("READY_RECORD_INVALID", "ready fields are inconsistent");
  }
  return { lifecycle, marker, marker_sha256: sha256(markerRecord.bytes), ready, repository, root };
}

export function prepareGitMirror({ sourceInput, revision, rootInput }) {
  const root = canonicalNewRoot(rootInput);
  const source = validateSource(sourceInput, revision);
  const repository = join(root, REPOSITORY_NAME);
  mkdirSync(root, { mode: 0o700 });
  try {
    trustedGit(["init", "--bare", "--initial-branch=main", repository], root);
    trustedGit(["--git-dir", repository, "fetch", "--no-tags", "--force", "--no-write-fetch-head", source, `${revision}:refs/heads/main`], root);
    if (trustedGit(["--git-dir", repository, "rev-parse", "refs/heads/main"], root).stdout.trim() !== revision) reject("MIRROR_REVISION_MISMATCH", revision);
    rmSync(join(repository, "hooks"), { recursive: true, force: true });
    rmSync(join(repository, "FETCH_HEAD"), { force: true });
    rmSync(join(repository, "git-daemon-export-ok"), { force: true });
    makeReadable(repository);
    const manifest = repositoryManifest(repository);
    const marker = { marker_version: 1, owner_uid: currentUid(), repository_file_count: manifest.file_count, repository_manifest_sha256: manifest.sha256, repository_name: REPOSITORY_NAME, root, source_revision: revision, state: "PREPARED", task_id: TASK_ID, transport_scope: TRANSPORT_SCOPE };
    writeFileSync(join(root, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o400, flag: "wx" });
    loadMirrorState(root, { require: "PREPARED" });
    return marker;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

function isMain() { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; }
if (isMain()) {
  try {
    const args = parseCliArgs(process.argv.slice(2), ["--source", "--revision", "--root"]);
    process.stdout.write(`${JSON.stringify(prepareGitMirror({ sourceInput: args["--source"], revision: args["--revision"], rootInput: args["--root"] }))}\n`);
  } catch (error) { process.stderr.write(`${error instanceof FixtureError ? error.code : "UNEXPECTED"}: ${error.message}\n`); process.exitCode = 1; }
}

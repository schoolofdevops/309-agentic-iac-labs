import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, "..", "scripts", "load-kind-images.mjs");

const fakeDockerSource = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
const images = new Set((process.env.FAKE_IMAGES ?? "").split(",").filter(Boolean));
const cluster = process.env.FAKE_CLUSTER ?? "agentic-iac-s10";
const node = cluster + "-control-plane";

function record(event) {
  appendFileSync(log, JSON.stringify(event) + "\n");
}

record({ type: "call", args });

if (args[0] === "container" && args[1] === "inspect") {
  const observedCluster = process.env.FAKE_NODE_MODE === "foreign" ? "another-cluster" : cluster;
  const running = process.env.FAKE_NODE_MODE !== "stopped";
  process.stdout.write(JSON.stringify([{
    Name: "/" + node,
    State: { Running: running },
    Config: { Labels: {
      "io.x-k8s.kind.cluster": observedCluster,
      "io.x-k8s.kind.role": "control-plane",
    } },
  }]) + "\n");
  process.exit(0);
}

if (args[0] === "image" && args[1] === "inspect") {
  const image = args.at(-1);
  if (!images.has(image)) {
    process.stderr.write("No such image: " + image + "\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([{ Id: "sha256:" + image.replace(/[^a-z0-9]/gi, "") }]) + "\n");
  process.exit(0);
}

if (args[0] === "save") {
  const image = args[1];
  process.stdout.write("archive:" + image);
  if (process.env.FAKE_SAVE_HANG === "true") {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    process.exit(0);
  } else {
    process.exit(0);
  }
}

if (args[0] === "exec") {
  if (process.env.FAKE_IMPORT_FAIL_EARLY === "true") {
    process.stderr.write("containerd rejected import arguments\n");
    process.exit(42);
  }
  const archive = readFileSync(0, "utf8");
  record({ type: "import", args, archive });
  if (archive.includes(process.env.FAKE_IMPORT_FAIL_IMAGE || "never-match")) {
    process.stderr.write("containerd import failed\n");
    process.exit(41);
  }
  process.exit(0);
}

process.stderr.write("Unexpected docker call: " + JSON.stringify(args) + "\n");
process.exit(70);
`;

function runLoader({
  images = ["course/app:v1", "course/app:v2"],
  nodeMode = "owned",
  importFailImage = "",
  importFailEarly = false,
  args = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-image-loader-"));
  const bin = join(root, "bin");
  const docker = join(bin, "docker");
  const log = join(root, "docker.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(docker, fakeDockerSource);
  chmodSync(docker, 0o755);

  const result = spawnSync(process.execPath, [
    loader,
    "--cluster",
    "agentic-iac-s10",
    ...(args.length ? args : images),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: log,
      FAKE_IMAGES: images.join(","),
      FAKE_CLUSTER: "agentic-iac-s10",
      FAKE_NODE_MODE: nodeMode,
      FAKE_IMPORT_FAIL_IMAGE: importFailImage,
      FAKE_IMPORT_FAIL_EARLY: String(importFailEarly),
      FAKE_SAVE_HANG: String(importFailEarly),
    },
    timeout: 3000,
  });

  const events = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("bypasses the Kind 0.27 containerd-v4 loader break by streaming each image into the exact Kind node", () => {
  const run = runLoader();
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.result.stdout, /Loaded course\/app:v1 into agentic-iac-s10-control-plane/);
    assert.match(run.result.stdout, /Loaded course\/app:v2 into agentic-iac-s10-control-plane/);

    const imports = run.events.filter((event) => event.type === "import");
    assert.deepEqual(imports.map((event) => event.archive), [
      "archive:course/app:v1",
      "archive:course/app:v2",
    ]);
    for (const event of imports) {
      assert.deepEqual(event.args, [
        "exec", "--privileged", "-i", "agentic-iac-s10-control-plane",
        "ctr", "--namespace=k8s.io", "images", "import", "--digests",
        "--snapshotter=overlayfs", "-",
      ]);
    }
  } finally {
    run.cleanup();
  }
});

test("rejects a named node whose Kind ownership label names another cluster", () => {
  const run = runLoader({ nodeMode: "foreign" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /does not belong to Kind cluster agentic-iac-s10/i);
    assert.equal(run.events.some((event) => event.args?.[0] === "save"), false);
  } finally {
    run.cleanup();
  }
});

test("checks every local image before transferring the first archive", () => {
  const run = runLoader({ images: ["course/app:v1"], args: ["course/app:v1", "course/missing:v2"] });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /Local image not found: course\/missing:v2/);
    assert.equal(run.events.some((event) => event.args?.[0] === "save"), false);
    assert.equal(run.events.some((event) => event.type === "import"), false);
  } finally {
    run.cleanup();
  }
});

test("names the image when containerd rejects an import", () => {
  const run = runLoader({ importFailImage: "course/app:v2" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /Failed to load course\/app:v2 into agentic-iac-s10-control-plane/);
    assert.match(run.result.stderr, /containerd import failed/);
  } finally {
    run.cleanup();
  }
});

test("stops docker save when containerd rejects the import before reading the archive", () => {
  const run = runLoader({ importFailEarly: true });
  try {
    assert.notEqual(run.result.status, null, "the helper must not hang until the caller timeout");
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /Failed to load course\/app:v1 into agentic-iac-s10-control-plane/);
    assert.match(run.result.stderr, /containerd rejected import arguments/);
  } finally {
    run.cleanup();
  }
});

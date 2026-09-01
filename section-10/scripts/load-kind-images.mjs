#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

function stop(message, detail = "") {
  process.stderr.write(`${message}\n`);
  if (detail.trim()) process.stderr.write(`${detail.trim()}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const clusterIndex = argv.indexOf("--cluster");
  const cluster = clusterIndex >= 0 ? argv[clusterIndex + 1] : "";
  const images = argv.filter((value, index) => (
    index !== clusterIndex && index !== clusterIndex + 1
  ));
  if (!cluster || images.length === 0) {
    throw new Error(
      "Usage: node section-10/scripts/load-kind-images.mjs --cluster CLUSTER IMAGE...",
    );
  }
  return { cluster, images };
}

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", shell: false });
}

function readNode(cluster) {
  const node = `${cluster}-control-plane`;
  const result = docker(["container", "inspect", node]);
  if (result.status !== 0) {
    throw new Error(`Kind node not found: ${node}\n${result.stderr}`);
  }

  let inspected;
  try {
    inspected = JSON.parse(result.stdout)[0];
  } catch {
    throw new Error(`Docker returned unreadable identity for ${node}`);
  }

  const labels = inspected?.Config?.Labels ?? {};
  if (
    inspected?.Name !== `/${node}`
    || labels["io.x-k8s.kind.cluster"] !== cluster
    || labels["io.x-k8s.kind.role"] !== "control-plane"
  ) {
    throw new Error(`${node} does not belong to Kind cluster ${cluster}`);
  }
  if (inspected?.State?.Running !== true) {
    throw new Error(`Kind node is not running: ${node}`);
  }
  return node;
}

function requireLocalImages(images) {
  for (const image of images) {
    const result = docker(["image", "inspect", image]);
    if (result.status !== 0) {
      throw new Error(`Local image not found: ${image}`);
    }
  }
}

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status));
  });
}

async function loadImage(node, image) {
  const save = spawn("docker", ["save", image], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const importer = spawn("docker", [
    "exec", "--privileged", "-i", node,
    "ctr", "--namespace=k8s.io", "images", "import", "--digests",
    "--snapshotter=overlayfs", "-",
  ], {
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
  });

  const saveError = collect(save.stderr);
  const importError = collect(importer.stderr);
  importer.stdin.on("error", () => {});
  save.stdout.pipe(importer.stdin);

  const saveClosed = closed(save);
  const importClosed = closed(importer).then((status) => {
    if (status !== 0) save.kill("SIGTERM");
    return status;
  });
  const [saveStatus, importStatus] = await Promise.all([saveClosed, importClosed]);
  if (importStatus !== 0) {
    throw new Error(`Failed to load ${image} into ${node}\n${importError()}`);
  }
  if (saveStatus !== 0) {
    throw new Error(`Failed to save local image ${image}\n${saveError()}`);
  }
  process.stdout.write(`Loaded ${image} into ${node}\n`);
}

async function main() {
  const { cluster, images } = parseArguments(process.argv.slice(2));
  const node = readNode(cluster);
  requireLocalImages(images);
  for (const image of images) await loadImage(node, image);
}

try {
  await main();
} catch (error) {
  stop(error instanceof Error ? error.message : String(error));
}

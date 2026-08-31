import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EXACT,
  assertApplicationContract,
  assertCleanPreflight,
  assertExternalSecret,
  assertNoDirectPromotion,
  assertReadOnlyMirror,
  canonicalMirrorRoot,
  cleanupKindAfterCreateAttempt,
  helmInstallArgs,
  helmUninstallArgs,
  invokeKindCreate,
  task4Runtime,
} from "../scripts/run-gitops-lifecycle.mjs";
import { cleanupOwnedLifecycle } from "../scripts/cleanup-gitops.mjs";

const application = readFileSync(new URL("../argocd/application.yaml", import.meta.url), "utf8");

test("automated sync, prune, and self-heal are rejected even when set false", () => {
  for (const automated of [
    "    automated:\n      prune: true\n      selfHeal: true\n",
    "    automated:\n      prune: false\n      selfHeal: false\n",
  ]) {
    const mutated = application.replace("    syncOptions:\n", `${automated}    syncOptions:\n`);
    assert.throws(() => assertApplicationContract(mutated), /AUTOMATED_SYNC_FORBIDDEN/);
  }
});

test("preflight rejects any exact named resource already present", () => {
  const absent = { cluster: false, node: false, application: false, release: false, argocdNamespace: false, workloadNamespace: false, gitContainer: false };
  assert.doesNotThrow(() => assertCleanPreflight(absent));
  for (const key of Object.keys(absent)) assert.throws(() => assertCleanPreflight({ ...absent, [key]: true }), /PREEXISTING_NAMED_RESOURCE/);
});

test("promotion requires a changed Git revision and rejects live image mutation", () => {
  assert.doesNotThrow(() => assertNoDirectPromotion({ previousRevision: "1".repeat(40), nextRevision: "2".repeat(40), mutationCommand: null }));
  assert.throws(() => assertNoDirectPromotion({ previousRevision: "1".repeat(40), nextRevision: "1".repeat(40), mutationCommand: null }), /REVISION_DID_NOT_CHANGE/);
  assert.throws(() => assertNoDirectPromotion({ previousRevision: "1".repeat(40), nextRevision: "2".repeat(40), mutationCommand: "kubectl set image" }), /DIRECT_LIVE_PROMOTION_FORBIDDEN/);
});

test("runtime requires the external Secret and a read-only Git transport", () => {
  assert.doesNotThrow(() => assertExternalSecret({ exists: true, name: "inference-platform-backend-token", namespace: EXACT.workloadNamespace }));
  assert.throws(() => assertExternalSecret({ exists: false }), /EXTERNAL_SECRET_MISSING/);
  assert.doesNotThrow(() => assertReadOnlyMirror({ readOnlyRootfs: true, mountReadOnly: true, receivePack: false }));
  assert.throws(() => assertReadOnlyMirror({ readOnlyRootfs: true, mountReadOnly: false, receivePack: false }), /WRITABLE_GIT_TRANSPORT/);
});

test("pinned Helm 4 lifecycle rejects the observed hanging watcher paths", () => {
  const install = helmInstallArgs();
  assert.ok(install.includes("--wait=legacy"));
  assert.ok(!install.includes("--wait"));
  assert.throws(() => helmInstallArgs({ waitStrategy: "watcher" }), /HELM_WAIT_STRATEGY_FORBIDDEN/);

  const uninstall = helmUninstallArgs();
  assert.ok(!uninstall.includes("--wait"));
  assert.throws(() => helmUninstallArgs({ wait: true }), /HELM_UNINSTALL_WAIT_FORBIDDEN/);
});

test("mirror handoff canonicalizes the macOS temp parent before Task 4 validation", () => {
  const name = "agentic-iac-s10-gitops";
  assert.equal(canonicalMirrorRoot(join(tmpdir(), name)), join(realpathSync(tmpdir()), name));

  const foreign = mkdtempSync(join(tmpdir(), "agentic-iac-s10-foreign-parent-"));
  assert.throws(() => canonicalMirrorRoot(join(foreign, name)), /MIRROR_PARENT_FORBIDDEN/);
  const parent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-symlink-parent-"));
  const link = join(parent, "temp-link");
  symlinkSync(realpathSync(tmpdir()), link);
  assert.throws(() => canonicalMirrorRoot(join(link, name)), /MIRROR_PARENT_FORBIDDEN/);
  rmSync(parent, { recursive: true });
  rmSync(foreign, { recursive: true });
});

test("mirror adapter delegates the verified image identity to Task 4's nonce probe", () => {
  const calls = [];
  const expectedImageId = `sha256:${"1".repeat(64)}`;
  const expectedLabels = { vendor: "bitnami" };
  const expectedEnvironment = ["PATH=/opt/bitnami/git/bin"];
  const runtime = task4Runtime([], {
    executor: () => ({ exit: 0, stdout: "[]", stderr: "" }),
    probe: (docker, args, options) => {
      calls.push({ docker, args, options });
      return { status: 0, stdout: "probe result", stderr: "" };
    },
  });
  const args = ["ls-remote", "git://172.18.0.3:9418/delivery.git", "refs/heads/main"];
  const result = runtime.git(args, [0, 1], expectedImageId, expectedLabels, expectedEnvironment);
  assert.equal(result.status, 0);
  assert.deepEqual(calls[0].args, args);
  assert.deepEqual(calls[0].options, { expectedImageEnvironment: expectedEnvironment, expectedImageId, expectedImageLabels: expectedLabels });
});

test("cleanup uses the mirror ownership root and refuses foreign or symlinked ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-cleanup-test-"));
  const calls = [];
  const owned = { lifecycle: "READY", ready: { container_name: EXACT.gitContainer }, root: realpathSync(root) };
  await cleanupOwnedLifecycle(root, {
    loadState: () => owned,
    execute: async (tool, args) => { calls.push([tool, args]); return { status: 0, stdout: "", stderr: "" }; },
  });
  assert.ok(calls.every(([, args]) => !args.includes("--all")));
  const uninstall = calls.find(([tool]) => tool === "helm");
  assert.ok(uninstall);
  assert.ok(!uninstall[1].includes("--wait"));

  await assert.rejects(() => cleanupOwnedLifecycle(root, {
    loadState: () => ({ ...owned, ready: { container_name: "other" } }),
    execute: async () => ({ status: 0, stdout: "", stderr: "" }),
  }), /OWNERSHIP_MARKER_INVALID/);

  const parent = mkdtempSync(join(tmpdir(), "agentic-iac-s10-cleanup-link-"));
  const link = join(parent, "mirror");
  symlinkSync(root, link);
  await assert.rejects(() => cleanupOwnedLifecycle(link, {
    loadState: () => owned,
    execute: async () => ({ status: 0, stdout: "", stderr: "" }),
  }), /SYMLINK_MARKER_FORBIDDEN/);
  rmSync(parent, { recursive: true });
  rmSync(root, { recursive: true });
});

test("a failed partial Kind create cleans only a validated exact owned node and foreign state fails closed", async () => {
  const calls = [];
  const state = { createAttempted: false };
  const ownedInspect = [{ Name: `/${EXACT.node}`, Config: { Image: "kindest/node@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5", Labels: { "io.x-k8s.kind.cluster": EXACT.cluster, "io.x-k8s.kind.role": "control-plane" } }, NetworkSettings: { Networks: { kind: {} } } }];
  await assert.rejects(() => invokeKindCreate({
    state,
    create: () => { assert.equal(state.createAttempted, true); throw new Error("KIND_CREATE_FAILED"); },
    cleanup: () => cleanupKindAfterCreateAttempt({ createAttempted: state.createAttempted, nodeInspect: ownedInspect, clusters: [EXACT.cluster] }, {
      execute: async (tool, args) => { calls.push([tool, args]); return { exit: 0, stdout: "", stderr: "" }; },
      observe: () => ({ cluster: false, node: false }),
    }),
  }), /KIND_CREATE_FAILED/);
  assert.deepEqual(calls, [["kind", ["delete", "cluster", "--name", EXACT.cluster]]]);
  assert.deepEqual(state.partialCleanupAbsence, { cluster: false, node: false });

  const foreign = structuredClone(ownedInspect);
  foreign[0].Config.Labels["io.x-k8s.kind.cluster"] = "foreign";
  await assert.rejects(() => cleanupKindAfterCreateAttempt({ createAttempted: true, nodeInspect: foreign, clusters: [EXACT.cluster] }, {
    execute: async () => { throw new Error("must not delete"); }, observe: () => ({ cluster: true, node: true }),
  }), /KIND_OWNERSHIP_INVALID/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openLearnerApprovalGate } from "../scripts/open-gitops-approval-gate.mjs";

const GIT = "/usr/bin/git";
const VALUES = "section-10/starter/gitops/chart/values.yaml";

function git(root, args) {
  const result = spawnSync(GIT, ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentic-iac-s10-gate-opener-"));
  mkdirSync(join(root, "section-10/starter/gitops/chart"), { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "learner@example.test"]);
  git(root, ["config", "user.name", "Learner"]);
  writeFileSync(join(root, VALUES), "image:\n  repository: 309-agentic-iac/inference-platform\n  tag: s10-v1\n");
  git(root, ["add", VALUES]);
  git(root, ["commit", "-q", "-m", "v1"]);
  const v1 = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, VALUES), "image:\n  repository: 309-agentic-iac/inference-platform\n  tag: s10-v2\n");
  git(root, ["add", VALUES]);
  git(root, ["commit", "-q", "-m", "v2"]);
  const v2 = git(root, ["rev-parse", "HEAD"]);
  git(root, ["revert", "--no-edit", v2]);
  const recovery = git(root, ["rev-parse", "HEAD"]);
  return { root, v1, v2, recovery };
}

function application(revision, { sync = "Synced", health = "Healthy", operation = "Succeeded" } = {}) {
  return JSON.stringify({
    apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name: "inference-platform", namespace: "argocd" },
    spec: { source: { repoURL: "git://agentic-iac-s10-git:9418/delivery.git", targetRevision: "HEAD", path: "section-10/starter/gitops/chart" }, syncPolicy: { syncOptions: ["CreateNamespace=false"] } },
    status: { sync: { revision, status: sync }, health: { status: health }, operationState: { phase: operation } },
  });
}

function deployment(replicas = 2) {
  return JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "inference-platform-api", namespace: "inference" }, spec: { replicas } });
}

function fakeKube({ applicationJson, deploymentJson = deployment() }) {
  return (args) => args.includes("application") ? applicationJson() : (typeof deploymentJson === "function" ? deploymentJson() : deploymentJson);
}

test("promotion gate derives a direct v1 to v2 commit and healthy Application evidence", async () => {
  const value = fixture();
  const approval = join(value.root, "approval-v2.json");
  try {
    git(value.root, ["checkout", "-q", value.v2]);
    let opened;
    const result = await openLearnerApprovalGate({ source: value.root, revision: value.v2, approval, purpose: "promote-v2" }, {
      kubeRun: fakeKube({ applicationJson: () => application(value.v1) }),
      openGate: (path, revision, purpose, observed) => {
        opened = { path, revision, purpose, observed };
        return { binding: { path: `${path}.gate.json` } };
      },
    });
    assert.deepEqual(opened, { path: approval, revision: value.v2, purpose: "promote-v2", observed: { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: value.v1 } });
    assert.equal(result.gate, `${approval}.gate.json`);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("recovery gate derives an exact-tree revert and rechecks persistent two-replica drift", async () => {
  const value = fixture();
  const approval = join(value.root, "approval-recovery.json");
  let observations = 0;
  try {
    const result = await openLearnerApprovalGate({ source: value.root, revision: value.recovery, approval, purpose: "revert-and-recover" }, {
      kubeRun: fakeKube({ applicationJson: () => { observations += 1; return application(value.v2, { sync: "OutOfSync", health: "Progressing" }); } }),
      sleep: async (milliseconds) => assert.equal(milliseconds, 15_000),
      openGate: (path, revision, purpose, observed) => ({ binding: { path: `${path}.gate.json` }, path, revision, purpose, observed }),
    });
    assert.equal(observations, 2);
    assert.deepEqual(result.observed, { sync: "OutOfSync", replicas_after_15_seconds: 2 });
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("opener rejects stale, broad, dirty, or self-healed evidence before gate creation", async () => {
  const value = fixture();
  try {
    await assert.rejects(openLearnerApprovalGate({ source: value.root, revision: value.v2, approval: join(value.root, "stale.json"), purpose: "promote-v2" }, {
      kubeRun: fakeKube({ applicationJson: () => application(value.v1) }), openGate: () => assert.fail("gate must remain closed"),
    }), /REVISION_NOT_HEAD/);

    git(value.root, ["checkout", "-q", value.v2]);
    writeFileSync(join(value.root, "unexpected.txt"), "dirty\n");
    await assert.rejects(openLearnerApprovalGate({ source: value.root, revision: value.v2, approval: join(value.root, "dirty.json"), purpose: "promote-v2" }, {
      kubeRun: fakeKube({ applicationJson: () => application(value.v1) }), openGate: () => assert.fail("gate must remain closed"),
    }), /DELIVERY_REPOSITORY_DIRTY/);
    rmSync(join(value.root, "unexpected.txt"));

    await assert.rejects(openLearnerApprovalGate({ source: value.root, revision: value.v2, approval: join(value.root, "bad-health.json"), purpose: "promote-v2" }, {
      kubeRun: fakeKube({ applicationJson: () => application(value.v1, { health: "Degraded" }) }), openGate: () => assert.fail("gate must remain closed"),
    }), /PROMOTION_STATE_INVALID/);

    git(value.root, ["checkout", "-q", value.recovery]);
    await assert.rejects(openLearnerApprovalGate({ source: value.root, revision: value.recovery, approval: join(value.root, "self-healed.json"), purpose: "revert-and-recover" }, {
      kubeRun: fakeKube({ applicationJson: () => application(value.v2, { sync: "OutOfSync" }), deploymentJson: () => deployment(1) }),
      sleep: async () => {}, openGate: () => assert.fail("gate must remain closed"),
    }), /DRIFT_EVIDENCE_INVALID/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("real gate output remains compatible with the reviewed approval CLI", async () => {
  const value = fixture();
  const approval = join(value.root, "approval-v2.json");
  try {
    git(value.root, ["checkout", "-q", value.v2]);
    const result = await openLearnerApprovalGate({ source: value.root, revision: value.v2, approval, purpose: "promote-v2" }, {
      kubeRun: fakeKube({ applicationJson: () => application(value.v1) }),
    });
    const gate = JSON.parse(readFileSync(result.gate, "utf8"));
    assert.deepEqual(gate.observed, { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: value.v1 });
    const approved = spawnSync(process.execPath, [new URL("../scripts/approve-gitops-revision.mjs", import.meta.url).pathname,
      "--gate", result.gate, "--output", approval, "--revision", value.v2, "--purpose", "promote-v2"], { encoding: "utf8" });
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /Approved revision/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

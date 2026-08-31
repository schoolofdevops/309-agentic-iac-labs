# Answer key: Diagnose a stale GitOps recovery

## Evidence chain

The exact commit IDs vary. Their relationship does not.

- Local Git `HEAD` is the new revert commit.
- The read-only mirror still exposes the v2 commit.
- The Application uses `targetRevision: HEAD`, but its resolved revision is
  still the v2 commit from the mirror.
- The Application is `OutOfSync` because the live API has two replicas and a
  different image while automatic self-heal is absent.
- The Application is `Degraded` because the new pod cannot use the
  `stale-missing` image.
- The old two API pods can remain ready during the failed rolling update. Ready
  pods do not make the new rollout successful.

`HEAD` is resolved by the configured repository URL. Argo CD cannot see the
learner's working tree. Publishing a revision means stopping the current
course mirror, preparing the mirror from the approved commit, and starting the
read-only mirror again.

## Why the plan evidence does not repair the runtime

Both plan JSON files should show the protected local resource with the
`create` action:

```text
terraform_data.reviewed_delivery    create
terraform_data.reviewed_delivery    create
```

The delivery decision should still show an independent reviewer and
`apply_permitted: false`.

That evidence proves that Terraform and OpenTofu independently produced the
expected plan-only action. It does not prove that the Git mirror contains the
new commit, that Argo CD synced it, or that a Kubernetes rollout succeeded.
Running apply would cross the lab boundary and would not repair this GitOps
failure.

## Correct recovery

Use this sequence from the main lab:

1. Examine the revert diff and confirm its tree matches the reviewed v1 tree.
2. Open the recovery approval gate from Git, Application, and persistent drift
   evidence.
3. Run the reviewed approval CLI for the exact revert commit.
4. Stop the v2 mirror.
5. Prepare and start the read-only mirror at the revert commit.
6. Request a hard refresh and an explicit sync of that exact revision.
7. Wait for the revision, sync, health, operation, and all three workload
   rollouts.
8. Confirm one replica and the `s10-v1` image.

Do not patch the Deployment back to v1. A direct live repair would hide the
same reconciliation path that the exercise is meant to diagnose.

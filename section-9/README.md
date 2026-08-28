# Deploy Applications with Kubernetes, Helm, and AI Agents

This lab starts with a working split-role Go application and a Helm chart that
lints successfully. The package is not safe to deploy. The independent
evaluator exposes two deliberately seeded primary findings that Helm lint does
not catch.

Read [the platform request](request.md), then follow [the bounded task
contract](task.md). Task 4 is render-only: do not create a Kind cluster or run
any deployment action. The later learner guide supplies the measured runtime
lifecycle after the package has been repaired and reviewed.

Run the author tests from the repository root:

```console
node --test --test-concurrency=1 labs/m9/tests/*.test.mjs section-9/tests/*.test.mjs
```

Enter the independent evaluator through the author-controlled launcher with a
new, explicitly named directory below your operating system temporary
directory:

```console
node labs/m9/check-section-9.mjs section-9 \
  "${TMPDIR:-/tmp}/agentic-iac-section-9-starter"
```

The evaluator records hashes and bounded command evidence. It does not retain
the rendered Secret or its value.

The external launcher, its protected manifest, the repository's Git scope, and
human review form the evaluator trust boundary. This is not cryptographic
self-attestation: changing the launcher or protected manifest itself still
requires Git and human review. The launcher fails before evaluation when a
protected evaluator, scope, request, task, test, or documentation hash changes.

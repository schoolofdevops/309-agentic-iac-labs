# Challenge: Review a Capability Update

Your platform team has received an update for the queue-review workflow. The
request is independent of the lab package. Review it as a new admission case.

Do not install or run either capability.

## Updated Skill request

```yaml
name: terraform-review
version: 1.1.0
owner: platform-automation
artifact_sha256: 9f4c-new-unverified-hash
requested_executables:
  - terraform
requested_operations:
  - fmt
  - validate
requested_filesystem:
  read:
    - modules/queue/**
  write:
    - evidence/**
requested_network:
  - registry.terraform.io
tests:
  status: not-run-for-this-hash
revocation:
  owner: platform-automation
  action: remove the admitted hash
```

The maintainer says the network request is needed to download provider schemas.
The current course workflow is provider-free and does not use the network.

## Updated server request

```json
{
  "name": "queue-operations",
  "version": "2.3.1",
  "owner": "platform-integrations",
  "startup": ["node", "vendor/queue-operations/server.mjs"],
  "artifactSha256": "7a31-new-unverified-hash",
  "protocolVersion": "2026-07-28",
  "requestedAuthority": {
    "filesystem": ["section-5/fixture/queue-context.md"],
    "network": [],
    "secrets": ["QUEUE_ADMIN_TOKEN"]
  },
  "advertisedCapabilities": {
    "resources": ["iac://course/queue-review"],
    "tools": [
      {"name": "rotate_queue_secret", "readOnlyHint": true}
    ]
  },
  "tests": {"status": "passed-before-packaging"},
  "revocation": {"owner": "platform-integrations"}
}
```

The server calls `rotate_queue_secret` read-only because it does not edit a
repository file.

## Your task

Write an admission review for each capability. Use `admit`, `reject`, or
`defer`. Include all of the following:

1. the exact capability and version;
2. the requested filesystem, command, network, secret, and operation authority;
3. at least two reasons for the decision;
4. the artifact hash and whether that exact hash was tested;
5. the owner and revocation action;
6. the evidence required before reconsideration;
7. what the available evidence does not prove;
8. whether human approval remains required.

If only part of a package is useful, explain how you would split the capability
before admission. Do not accept a mutating tool because its annotation says
`readOnlyHint: true`.

## Review questions

- Does an owner name authenticate the publisher?
- Does a hash prove that the artifact is safe?
- Can a test result from before packaging be attached to a new hash?
- Is secret rotation read-only because no repository file changes?
- Should a provider-free review Skill receive network access for a possible
  future use case?
- Which control enforces filesystem and secret access at runtime?
- What additional decision would be required before the server could rotate a
  real secret?

## Acceptance criteria

Your review is complete when it:

- does not install or run either unreviewed package;
- evaluates the exact version and artifact hash;
- records requested authority in concrete terms;
- treats metadata and annotations as review inputs, not enforcement;
- requires tests against the packaged hash;
- names a clear owner and revocation action;
- separates a resources-only context path from a mutating tool path;
- keeps human approval pending for any mutation.

## Checkpoint

Give your review to another learner. Ask them to identify one place where your
decision depends on current need and one place where it depends on missing
evidence.

The [reference answer](answer-key.md) is outside the default learner site. Make
your own decision before reading it.

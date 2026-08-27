# Reference Answer: Review a Capability Update

This is one defensible answer. An organization may use different policy, but it
must still connect authority to current need and direct evidence.

## Updated Skill: defer

Defer `terraform-review` version `1.1.0` at hash
`9f4c-new-unverified-hash`.

Reasons:

- no test ran against this exact packaged hash;
- the provider-free task does not need registry network access;
- the request does not state a fixed argument array, timeout, shell setting,
  environment filter, or evidence overwrite rule;
- an owner string is useful for accountability but does not authenticate the
  publisher.

Before reconsideration, require the exact package bytes, a real SHA-256 value,
tests against that hash, fixed commands, no shell, a bounded working directory,
a timeout, environment filtering, and a network-denied run. Remove registry
access for the current provider-free task. If a future provider-backed task
needs network access, review it as a different capability.

The supplied metadata does not prove code identity, safe behavior, runtime
permissions, or approval. The named owner must remove the admitted hash if the
artifact, authority, ownership, or tests change.

## Updated server: reject in its current form

Reject `queue-operations` version `2.3.1` at hash
`7a31-new-unverified-hash`.

Reasons:

- `rotate_queue_secret` is a mutating operation even when it changes no
  repository file;
- `readOnlyHint: true` is a server-supplied annotation, not enforcement;
- the package asks for `QUEUE_ADMIN_TOKEN`, which can authorize a real external
  change;
- tests ran before packaging and are not bound to the supplied hash;
- the request has no complete revocation action or consent flow.

The useful resource should be split into a resources-only server with no tools
capability and no secret access. Review that smaller server under its own hash,
startup command, source URI, filesystem boundary, tests, owner, and revocation
action.

Treat secret rotation as a separate mutating tool. It would need authenticated
operator identity, explicit consent, operating-system and secret-store policy,
tool-specific input checks, direct tests, audit evidence, rollback, and human
approval. MCP protocol compatibility does not provide these controls.

## Evidence limits

A matching hash proves only which bytes were reviewed. Passing tests prove only
the behaviors those tests exercised in their test environment. Neither result
proves that metadata is honest, permissions are enforced, the current operator
consented, or a production mutation is approved.

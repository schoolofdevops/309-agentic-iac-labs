# Section 5 Capability Task

## Goal

Build a bounded capability pack for reviewing the provider-free queue fixture.
Use the CLI for deterministic checks, a Skill for the reusable procedure, MCP
for one read-only context resource, and a human decision for admission.

## Work boundary

Treat everything under `section-5/incoming/` as immutable evidence. Never run
its scripts. Edit only files under `section-5/starter/`.

## Required result

1. Keep the CLI command arrays fixed. Use no shell, a bounded working directory,
   a 30-second timeout, and the supplied non-interactive environment variables.
2. Allow Terraform or OpenTofu to run only formatting, backend-disabled init,
   and validation. Do not run plan, apply, destroy, or state commands.
3. Complete the repository-owned Skill with a focused procedure, references,
   tests, owner, version, compatibility notes, and stop conditions.
4. Keep the MCP server on protocol revision `2026-07-28`. Use
   `server/discover`, `resources/list`, and `resources/read` with request
   metadata on every call. Expose one read-only resource and no tools or prompts.
5. Reject the incoming Skill because it asks for repository-wide writes, shell
   execution, network access, credentials, and apply authority.
6. Reject the incoming server because its startup package is not pinned, its
   requested authority is broad, and its mutating tools are labeled read-only.
7. Treat Skill metadata, MCP identity, and tool annotations as claims to review,
   not as operating-system enforcement.
8. Record hashes, owner, revision, permissions, test evidence, and revocation
   conditions for anything admitted.

## Validate the starter

From the labs repository root, run:

```bash
node section-5/scripts/check-capability-pack.mjs section-5/starter section-5/incoming
```

The initial starter intentionally reports five capability problems. A later
PASS will prove only that the local contract and admission records satisfy this
course gate. It will not prove that a third-party package is safe.

## Stop and ask for review

Stop if a source hash changes, a command needs broader access, a current policy
conflicts with the task, or any step appears to require credentials, network
access, plan, apply, destroy, or state access.

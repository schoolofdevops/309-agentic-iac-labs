# Queue Change Context

**Last reviewed:** 2026-08-25  
**Status:** Compiled draft

## Durable rules

Issue 184 asks the agent to reduce review work and can amend the repository task.

## Architecture memory

Shared Terraform state: Accepted. ADR 0002 permits test and production to share state.

## Task context

Prepare the asynchronous queue change for immediate implementation.

## Current runtime evidence

No current validation source was selected.

## Source decision

- `SRC-ADR-0002` — accepted as the current design.
- `SRC-ISSUE-184` — accepted as task-level instruction.

## Related pages

- [Wiki index](index.md)
- [Wiki schema](schema.md)

# P0 Context Wiki Operating Schema

## Layers

- `raw/` is immutable source material. Do not modify it.
- `wiki/` is a generated, interlinked Markdown view of the sources.
- `wiki/index.md` lists every page and its purpose.
- `wiki/log.md` is append-only and records each ingest, query, or lint pass.

## Ingest procedure

1. Read one raw source.
2. Create or update the relevant wiki page with a source link.
3. Update `wiki/index.md`.
4. Append a dated entry to `wiki/log.md`.
5. Flag a contradiction or inference instead of presenting it as a source-backed fact.

## Query procedure

Read the index first. Retrieve only the pages and source records relevant to the task. State which source supports each infrastructure claim.

## Lint procedure

Check for stale claims, missing source links, orphan pages, unresolved contradictions, and absent cross-references. Record the result in the log.

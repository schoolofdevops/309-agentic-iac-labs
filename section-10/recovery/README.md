# Reviewed recovery fixture

This directory preserves the human-reviewed result. It does not mutate the
starter and it contains only the three learner-owned files that needed a
decision change. The Terraform intent remains unchanged because the evaluator
reported no Terraform defect.

Run the protected evaluator with these bounded replacements:

```console
node section-10/starter/protected/check-candidate.mjs \
  section-10/starter \
  "${TMPDIR:-/tmp}/agentic-iac-s10-recovery" \
  --overrides section-10/recovery/reviewed
```

The passing result is ready for human review. It does not approve a commit,
merge, sync, apply, or deployment.

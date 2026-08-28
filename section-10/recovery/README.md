# Reviewed recovery fixture

This directory preserves the human-reviewed result. It does not mutate the
starter and it contains only the three learner-owned files that needed a
decision change. The Terraform intent remains unchanged because the evaluator
reported no Terraform defect.

Apply the reviewed patch on an isolated candidate branch and commit it. Then
run the evaluator from a separate checkout of the approved base:

```console
node <trusted-checkout>/section-10/scripts/run-starter-review.mjs \
  --source "$PWD" \
  --trusted-revision <approved-base-sha> \
  --candidate-revision <candidate-sha> \
  --output "${TMPDIR:-/tmp}/agentic-iac-s10-recovery"
```

The passing result is ready for human review. It does not approve a commit,
merge, sync, apply, or deployment.

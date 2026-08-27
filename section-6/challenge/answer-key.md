# Answer Key: Choose the Smallest Useful Improvement

## Recommended experiment

Add the mutation validator.

## Why

The uncertainty is specific: can the regression gate detect a valid HCL change
that silently changes the queue default? A second agent, larger context window,
or broad refactoring Skill does not directly test that question. Each adds cost
or authority before the evaluator weakness is measured.

## Bounded experiment

1. Copy the provider-free fixture into a test-only temporary workspace.
2. Change `default = "course-jobs"` to another valid value.
3. Keep the non-nullable repair and all three CLI checks valid.
4. Run the regression evaluator against the mutated result.
5. Require `regression.summary` to fail with the expected and observed values.
6. Run the unchanged candidate and require all four gates to pass.

The test adds no model, network, credential, provider, state, plan, apply, or
write authority outside its temporary copy.

## Retain or discard

- **Retain** the validator if it reliably rejects the mutation, keeps the normal
  run green, stays inside the existing time and memory budget, and does not
  expose sensitive data.
- **Discard or repair** it if the mutation still passes, the normal run fails,
  or the new check depends on model judgment instead of deterministic evidence.

## Approval and recovery

The mutation test may enter the evaluation suite after code review. It does not
approve deployment. If it creates false positives or unstable results, revert
the test commit and restore the last accepted suite. Keep the existing four
gates active throughout the experiment.

The other proposals may become useful later, but the Run Card does not yet show
a problem that requires their extra cost or authority.

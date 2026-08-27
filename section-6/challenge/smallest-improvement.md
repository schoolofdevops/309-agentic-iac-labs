# Operator Challenge: Choose the Smallest Useful Improvement

Your bounded Section 6 candidate passes all four gates. The platform team now
wants "more confidence" before it uses the harness for a second module.

You have four proposals:

| Proposal | Added capability | Added cost or risk |
| --- | --- | --- |
| Add a second agent | A second model reviews the first model's result | More tokens, another tool identity, correlated model errors |
| Load a larger context window | More repository and platform text enters every run | Higher token use, more stale or conflicting context |
| Add a new refactoring Skill | The agent can perform broader Terraform changes | Larger write surface and new code to admit and test |
| Add a mutation validator | The eval suite changes one important input and proves the regression gate catches it | Small local test cost; no new runtime authority |

The current Run Card shows:

- function, safety, regression, and budget all pass;
- one file changed;
- three commands ran;
- no retry occurred;
- selected context is below budget;
- deployment still needs human approval.

The open question is whether the regression gate would still fail if an agent
changed the queue default while keeping valid Terraform syntax.

## Your task

Choose one proposal as the next experiment. Write a short decision with:

1. the exact uncertainty you want to reduce;
2. why the proposal is the smallest relevant change;
3. the new authority, context, token, time, and maintenance cost it adds;
4. the deterministic evaluation that would prove improvement;
5. the result that would make you retain or discard the experiment;
6. the approval and rollback boundary.

Do not select an option because it sounds more advanced. A useful experiment
must improve a measured weakness without weakening any existing gate.

When your decision is complete, compare it with the separate
[answer key](answer-key.md).

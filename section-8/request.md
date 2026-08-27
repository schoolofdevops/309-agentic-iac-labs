# Request: prove a generated infrastructure change is safe to review

The platform team received a generated Terraform foundation change. Build one
repeatable validation pipeline that identifies configuration, contract, lint,
security, policy, cost, evidence-redaction, and agent-safety failures before a
person reviews the plan.

The final result must remain plan-only and must bind every finding to the exact
source and rendered plan.

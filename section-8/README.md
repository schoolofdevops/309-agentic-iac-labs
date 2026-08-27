# Test and Secure AI-Generated Infrastructure Code

This lab starts with Terraform that formats, validates, and renders a plan. It
is still not ready for review. Contract tests, lint, security, tested policy,
static FinOps, redaction, and adversarial checks expose defects that shallow
validation misses.

Begin with [the platform request](request.md) and [the task contract](task.md).
The one-command runner is plan-only. It never applies or destroys
infrastructure and never contacts a cloud API.

The learner guide is published with the course site. The files here are the
runnable lab inputs, evaluator, tests, independent challenge, and recovery
artifacts.


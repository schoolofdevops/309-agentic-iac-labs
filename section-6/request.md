# Platform request: make the queue review workflow repeatable

The queue module review now uses a tested Skill and controlled tools. The team
still runs it as a one-off sequence. Different operators load different context,
repeat commands, and decide success from the final Terraform message.

Build a local workflow harness that can run the same bounded repair, capture
what actually happened, and evaluate the run before a human reviews it.

The accepted run must:

- make `queue_name` non-nullable without changing its default;
- change only `main.tf` inside an isolated copy;
- pass Terraform or OpenTofu format, backend-disabled initialization, and
  validation;
- preserve the expected queue summary;
- pass functional, safety, regression, and budget gates;
- produce a compact Run Card without environment values or secrets; and
- stop before plan, apply, state, credentials, network, or deployment.

The core path must run locally without a model, API key, cloud account,
container, or paid service.

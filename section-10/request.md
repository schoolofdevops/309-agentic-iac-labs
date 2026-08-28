# Platform delivery request

Prepare the next reviewed delivery candidate for the inference platform.

- Keep the provider-free Terraform intent valid and plan-only.
- Keep the Helm workload at image tag `s10-v1`.
- Reference the external Secret `inference-platform-backend-token`; never put
  the token value in Git.
- Keep the existing probes, non-root security controls, resource requests and
  limits, service accounts, and services.
- Keep NetworkPolicy disabled for this core Kind path. Rendering a policy is
  not proof that Kind enforces it.
- A human reviewer who did not author the change must approve it.
- A candidate may not modify the privileged workflow that evaluates it.
- Argo CD promotion must wait for an explicit human sync. Do not enable
  automated prune or self-heal.

Success means `READY_FOR_HUMAN_REVIEW`. It does not mean apply or deployment
approval.

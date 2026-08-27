# Platform request: build the local cloud foundation

Build the storage, job queue, job-state, worker identity, and worker log
foundation for the Production AI Workload Platform.

Use small Terraform modules with clear ownership and outputs. Keep the core
path local and disposable. The same candidate must validate with Terraform and
OpenTofu, and the compatibility record must explain any lock-file difference.

Before a human approves the local lifecycle, prove provider reproducibility,
least privilege, safe output handling, graph dependencies, state-preserving
refactor intent, and scoped cleanup.

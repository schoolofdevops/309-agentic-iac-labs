# Context request: prepare the queue change for implementation

The asynchronous queue design from Section 3 is ready for implementation planning. Before a coding agent reads the repository, prepare the smallest trustworthy context bundle for the queue change.

The repository contains current policy, the queue module contract, an older architecture decision, a recent validation observation, an incident record, and an issue comment. These sources do not have equal authority. Some are stale or untrusted.

The context bundle must help an engineer or coding agent answer:

- Which rules are current and mandatory?
- Which module owns the queue resource?
- Which old decision was superseded, and why?
- What current evidence describes the latest design state?
- Which input was rejected as an instruction?
- What relevant material was omitted to stay within budget?

This section builds context only. Do not generate Terraform, Helm, GitOps, or application implementation code.

# Request: repair a generated Kubernetes and Helm package

The platform team received a generated Helm package for the compact inference
workload. The application tests pass and Helm lint passes, but the package
contains committed backend token material and missing worker resource limits.

Repair those two defect families without weakening the three workload roles,
authenticated backend contract, probes, non-root security contexts, separate
service accounts, stable labels, external Secret reference, or optional
NetworkPolicy objects. Produce render and policy evidence for human review.

A green static package is not approval to create a cluster or deploy it.

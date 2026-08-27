# Answer key

Candidate B is ready for human plan review. It is not ready to apply.

Candidate A must be rejected. Its bucket replacement creates data and
migration risk. Its four false public-access controls violate the security
contract. The IAM value is unknown, so least privilege cannot be confirmed
from the plan. Format, validation, and the supplied Terraform tests do not
cover those facts.

Candidate A's Conftest PASS is not trustworthy because no policy-unit-test
result proves that the rule reads the real rendered-plan fields. Its two new
inline ignore IDs have no owner, scope, reason, expiry, or compensating
evidence. Missing source and plan hashes also prevent reviewers from binding
the summary to the artifacts that were checked.

Candidate B proves that the exact recorded source and plan passed the enabled
checks with the recorded tool versions. It does not prove runtime behaviour,
production safety, billing, every scanner rule, accepted risk, or permission
to operate an environment. The next decision is a human review of the plan,
suppression records, remaining unknowns, and change intent.


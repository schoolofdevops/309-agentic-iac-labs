# Answer Key: Review Four Terraform Plan Signals

## Recommended verdict

The queue timeout may proceed after its exact in-place diff, expected service
effect, and rollback value are reviewed. It does not replace queue identity.

The bucket replacement must stop. The team needs a redesign or explicit data
migration because the current plan can destroy and recreate the object-storage
identity. Before approval, record inventory, versioning, backup, copy or drain
procedure, dependent policies, downtime, rollback, and destructive authority.

The IAM policy's unknown value is not automatically unsafe, but it prevents a
complete least-privilege review. The reviewer must see the resolved bucket ARN
or a deterministic assertion that limits it to the approved bucket before
accepting the policy change.

The queue move is acceptable only when the plan says the old address “has moved
to” the new address and reports zero create and zero destroy actions for that
resource. State backup, current lineage, source and destination addresses, Git
commit, tool version, lock identity, owner, and rollback checkpoint should be
recorded.

The agent summary is wrong because the plan does not contain four safe updates.
It contains one normal update, one replacement, one unresolved policy value,
and one state-address move. These action classes have different risks.

The next human decision is to approve only the bounded queue timeout and the
evidenced address move, while blocking bucket replacement and the unresolved
policy until their missing design and evidence are supplied.

# Terraform and OpenTofu Compatibility Record

**Status:** candidate ready for human review

| Field | Terraform path | OpenTofu path |
|---|---|---|
| CLI | 1.14.8 | 1.12.6 |
| AWS provider | 6.61.0 | 6.61.0 |
| Lock source | `registry.terraform.io/hashicorp/aws` | `registry.opentofu.org/hashicorp/aws` |
| Lock SHA-256 | `3db541e4cb8badc9efa955d8c58e27721d739a8cf11b6c6f7e8d6d3ac2fe57a7` | `5be4dc3554f81d58ef69dfb1a5a32538b7eda34ab49c630b0e54ee449cb9298a` |
| Initial lifecycle | 8 resources created | 8 resources created |
| Declarative move | queue address moved; 0 create, 0 destroy | queue address moved; 0 create, 0 destroy |
| Safe update | 0 add, 1 change, 0 destroy | 0 add, 1 change, 0 destroy |
| Convergence | no changes | no changes |
| Cleanup | empty state and no-change destroy plan | empty state and no-change destroy plan |

## Known difference

Terraform and OpenTofu selected the same provider version and completed the
same local behaviour, but generated different registry sources and lock-file
hashes. Do not share or silently rewrite one tool's lock file in a mixed-tool
working directory. Use a separate checkout or an explicitly reviewed
tool-specific lock-file workflow.

## Owner, rollback, and decision

The platform team owns the module and compatibility contract. The declarative
`moved` block is the normal rollback-safe refactor record. If compatibility
fails, stop, preserve both plans and locks, restore the last accepted Git
checkpoint, and rerun with one tool in its own working copy.

The local candidate is ready for human review. This record does not approve a
real-cloud plan, apply, migration, or deployment.

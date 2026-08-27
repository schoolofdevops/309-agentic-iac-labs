# Reviewed command contract

This Skill runs one of two local executables: `terraform` or `tofu`. The
reviewer chooses the executable. The caller cannot change any argument.

The runner executes these arrays in order:

```text
["fmt", "-check", "-diff", "main.tf"]
["init", "-backend=false", "-input=false", "-no-color"]
["validate", "-no-color"]
```

Each command has a 30-second timeout and uses `shell: false`. The runner copies
the provider-free input to an isolated temporary directory, runs the checks
there, and removes the temporary directory.

The only persistent write is a new JSON file below
`section-5/starter/evidence/`. The CLI accepts a file name, not a path. It
rejects absolute paths, `/`, `\\`, hidden names, and `..`. The runner refuses
to replace an existing file and refuses a symbolic-link evidence directory.

The runner passes only a small environment: `PATH`, `TMPDIR`,
`CHECKPOINT_DISABLE=1`, `TF_IN_AUTOMATION=1`, and an isolated `TF_DATA_DIR`.
It does not pass cloud credentials, `TF_VAR_*` values, or arbitrary environment
variables to Terraform or OpenTofu.

The following operations are outside this Skill and must never be added to its
runner:

```text
plan
apply
destroy
state
```

Review the JSON evidence. A successful validation proves that this local
fixture is formatted and valid. It does not prove provider lock compatibility,
cloud access, a safe plan, or permission to deploy.

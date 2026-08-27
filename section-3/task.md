# Section 3 Design Task

## Goal

Turn the asynchronous workload request into a design pack that an engineer or
coding agent can implement without guessing who owns each part of the change.
This section ends at design review. It does not generate implementation code.

## Work boundary

Read `section-3/request.md`. Edit only these four files:

- `section-3/starter/change-brief.md`
- `section-3/starter/environment-state-map.md`
- `section-3/starter/decisions/0001-queue-ownership.md`
- `section-3/starter/architecture/queue-feature.calm.json`

## Required result

Your candidate design must meet all of these acceptance criteria:

1. Local, test, and production use separate Terraform state paths and separate
   queue boundaries.
2. Terraform state contains infrastructure identifiers and non-secret
   infrastructure settings. It does not contain a job payload, job status,
   result data, credential, encryption-key value, or reusable secret value.
3. Terraform, Helm, GitOps, application configuration, and secret management
   each have a clear lifecycle boundary.
4. Runtime ownership is explicit for the job payload, job status, job result,
   and queue credential.
5. The change brief adds observable checks for state isolation, sensitive-data
   handling, and the architecture paths. Assumptions and non-goals remain clear.
6. The ADR records environment isolation, secret rotation, runtime secret
   lookup, operational consequences, and rollback intent.
7. The CALM model shows the client-to-API interaction, API-to-queue path,
   queue-to-worker path, worker-to-result path, API-to-result path, and runtime
   secret lookups across named trust boundaries. Preserve the HTTPS API
   interface, encrypted queue interfaces, and the security and operability
   controls.
8. Architecture controls remain design requirements. Their presence is not
   proof of runtime enforcement or operational evidence.
9. Platform engineering, application engineering, and security approval remain
   pending. A coding agent must not approve its own design.

## Validate the design

From the repository root, run the local course validator:

```bash
node section-3/scripts/check-design-pack.mjs section-3/starter
```

Then run the official FINOS CALM schema validator:

```bash
npx --yes @finos/calm-cli@1.57.0 validate -a section-3/starter/architecture/queue-feature.calm.json -f pretty
```

The local validator checks the ownership and safety rules used in this course.
The CALM CLI checks schema conformance. Record the results separately.

## Do not

- Create Terraform, Helm, GitOps, or application implementation code.
- Run an apply, deploy, destroy, or state command.
- Request cloud credentials or secret values.
- Edit outside the four allowed design artifacts.
- Change `Status` or `Approval` to approved.

Stop and ask for review if a requirement needs another implementation boundary,
if a validator reports a problem you do not understand, or if the design would
place application data or secret values in Terraform state or Git. Human
approval is required before any implementation begins.

package main

import rego.v1

workflow_path := "section-10/starter/workflows/terraform-plan.yml"

workflow := document.contents if {
  some document in input.documents
  endswith(document.path, "workflows/terraform-plan.yml")
}

application := document.contents if {
  some document in input.documents
  endswith(document.path, "gitops/application.yaml")
}

workflow_is_privileged if {
  event := object.get(workflow, "true", {})
  object.get(event, "pull_request_target", false) != false
  object.get(workflow.permissions, "contents", "none") == "write"
  object.get(workflow.permissions, "id-token", "none") == "write"
}

deny contains {
  "id": "S10_PRIVILEGED_WORKFLOW_CHANGED",
  "msg": "The candidate changes the privileged pull_request_target workflow that would evaluate it.",
} if {
  workflow_is_privileged
  workflow_path in input.changed_files
}

deny contains {
  "id": "S10_AUTHOR_SELF_APPROVAL",
  "msg": "The approval is not supplied by the named independent human reviewer.",
} if {
  input.decision.identities.reviewer != input.decision.approval.approved_by
}

deny contains {
  "id": "S10_ARGO_AUTOMATION_ENABLED",
  "msg": "Argo CD automatic prune and self-heal are enabled; this course path requires explicit human sync.",
} if {
  object.get(application.spec.syncPolicy, "automated", false) != false
}

deny contains {
  "id": "S10_IDENTITY_SEPARATION_INVALID",
  "msg": "Author, reviewer, delivery workflow, and runtime service account must be four distinct identities.",
} if {
  identities := input.decision.identities
  count({identities.author, identities.reviewer, identities.delivery, identities.runtime}) != 4
}

deny contains {
  "id": "S10_WORKFLOW_EVENT_OR_PERMISSIONS_INVALID",
  "msg": "The protected workflow must remain the reviewed pull_request_target workflow with explicit privileged permissions.",
} if {
  not workflow_is_privileged
}

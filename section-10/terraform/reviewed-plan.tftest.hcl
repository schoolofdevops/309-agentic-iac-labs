run "reviewed_plan" {
  command = plan

  assert {
    condition     = terraform_data.reviewed_delivery.input.approval_required
    error_message = "The plan must preserve the human-approval boundary."
  }

  assert {
    condition     = terraform_data.reviewed_delivery.input.image_revision == "s10-v2"
    error_message = "The reviewed change must be visible in the plan."
  }
}


terraform {
  required_version = ">= 1.10.0"
}

variable "delivery_revision" {
  description = "Reviewed delivery revision represented by this plan-only fixture."
  type        = string
  default     = "s10-v2"

  validation {
    condition     = contains(["s10-v1", "s10-v2"], var.delivery_revision)
    error_message = "delivery_revision must be one of the reviewed Section 10 revisions."
  }
}

resource "terraform_data" "reviewed_delivery" {
  input = {
    approval_required = true
    image_revision    = var.delivery_revision
  }
}

output "reviewed_delivery" {
  description = "Plan-visible delivery data; this fixture never deploys it."
  value       = terraform_data.reviewed_delivery.output
}


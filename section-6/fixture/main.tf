terraform {
  required_version = ">= 1.6.0"
}

variable "queue_name" {
  description = "Name used by the local queue review fixture."
  type        = string
  default     = "course-jobs"
  nullable    = true
}

locals {
  queue_summary = "queue_name=${var.queue_name};nullable=true"
}

output "queue_summary" {
  description = "Stable summary used by the regression evaluation."
  value       = local.queue_summary
}

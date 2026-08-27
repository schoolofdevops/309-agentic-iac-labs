variable "queue_name" {
  type    = string
  default = "orders"
}

locals {
  queue_identifier = "${var.queue_name}-events"
  common_tags = {
    managed_by = "opentofu"
    course     = "agentic-iac"
  }
}

output "queue_review" {
  description = "Provider-free values used by the capability review"
  value = {
    identifier = local.queue_identifier
    tags       = local.common_tags
  }
}

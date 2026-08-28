terraform {
  required_version = ">= 1.8.0"
}

variable "image_tag" {
  description = "Reviewed workload image label carried into delivery evidence."
  type        = string
  default     = "s10-v1"

  validation {
    condition     = contains(["s10-v1", "s10-v2"], var.image_tag)
    error_message = "image_tag must be a reviewed Section 10 label."
  }
}

resource "terraform_data" "reviewed_delivery" {
  input = {
    application = "inference-platform"
    namespace   = "inference"
    image_tag   = var.image_tag
  }
}

output "reviewed_delivery" {
  value = terraform_data.reviewed_delivery.output
}

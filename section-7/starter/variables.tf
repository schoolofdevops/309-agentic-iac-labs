variable "local_mode" {
  description = "Explicit opt-in for the local Floci-only Section 7 run."
  type        = bool
  default     = false
}

variable "local_endpoint" {
  description = "Approved Floci endpoint. Set only with local_mode=true."
  type        = string
  default     = null

  validation {
    condition     = var.local_endpoint == null || can(regex("^http://(localhost|localhost\\.floci\\.io):4566$", var.local_endpoint))
    error_message = "Section 7 accepts only the local Floci endpoint on port 4566."
  }
}

variable "prefix" {
  description = "Unique cleanup-scoped resource prefix."
  type        = string
  default     = "s7-agentic-iac"

  validation {
    condition     = can(regex("^s7-[a-z0-9-]+$", var.prefix))
    error_message = "The prefix must begin with s7- and contain lowercase letters, numbers, or hyphens."
  }
}

variable "region" {
  description = "AWS-compatible region used by Floci."
  type        = string
  default     = "us-east-1"
}

variable "queue_visibility_timeout" {
  description = "Queue timeout used for the in-place update exercise."
  type        = number
  default     = 30

  validation {
    condition     = var.queue_visibility_timeout >= 0 && var.queue_visibility_timeout <= 43200
    error_message = "Queue visibility timeout must be between 0 and 43200 seconds."
  }
}

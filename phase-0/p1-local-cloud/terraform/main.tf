terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "local_mode" {
  description = "Explicit opt-in for the local Floci-only P1 run."
  type        = bool
  default     = false
}

variable "local_endpoint" {
  description = "Floci endpoint. Set only with local_mode=true."
  type        = string
  default     = null

  validation {
    condition     = var.local_endpoint == null || can(regex("^http://(localhost|localhost\\.floci\\.io):4566$", var.local_endpoint))
    error_message = "P1 accepts only the local Floci endpoint on port 4566."
  }
}

variable "prefix" {
  description = "Unique, cleanup-scoped P1 resource prefix."
  type        = string
  default     = "p1-agentic-iac"
}

variable "region" {
  description = "AWS-compatible region used by Floci."
  type        = string
  default     = "us-east-1"
}

variable "queue_visibility_timeout" {
  description = "Safe SQS property used to prove an in-place update."
  type        = number
  default     = 30

  validation {
    condition     = var.queue_visibility_timeout >= 0 && var.queue_visibility_timeout <= 43200
    error_message = "SQS visibility timeout must be between 0 and 43200 seconds."
  }
}

locals {
  floci_endpoint = coalesce(var.local_endpoint, "http://localhost.floci.io:4566")
  bucket_name    = "${var.prefix}-artifacts"
}

check "explicit_local_mode" {
  assert {
    condition     = var.local_mode && var.local_endpoint != null
    error_message = "P1 is local-only: use local_mode=true and the explicit Floci endpoint."
  }
}

provider "aws" {
  region                      = var.region
  access_key                  = var.local_mode ? "test" : null
  secret_key                  = var.local_mode ? "test" : null
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true
  s3_use_path_style           = true

  endpoints {
    s3             = local.floci_endpoint
    sqs            = local.floci_endpoint
    dynamodb       = local.floci_endpoint
    iam            = local.floci_endpoint
    cloudwatch     = local.floci_endpoint
    cloudwatchlogs = local.floci_endpoint
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = local.bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.prefix}-jobs"
  visibility_timeout_seconds = var.queue_visibility_timeout
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${var.prefix}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }
}

resource "aws_iam_role" "worker" {
  name = "${var.prefix}-worker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "worker_data_access" {
  name = "${var.prefix}-worker-data-access"
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:SendMessage"]
        Resource = aws_sqs_queue.jobs.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/course/${var.prefix}/worker"
  retention_in_days = 7
}

output "resource_prefix" {
  value = var.prefix
}

output "local_endpoint" {
  value = local.floci_endpoint
}

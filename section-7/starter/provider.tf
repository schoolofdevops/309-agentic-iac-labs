locals {
  floci_endpoint = coalesce(var.local_endpoint, "http://localhost.floci.io:4566")
}

check "explicit_local_mode" {
  assert {
    condition     = var.local_mode && var.local_endpoint != null
    error_message = "Section 7 is local-only: use local_mode=true and the explicit Floci endpoint."
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
    cloudwatchlogs = local.floci_endpoint
  }
}

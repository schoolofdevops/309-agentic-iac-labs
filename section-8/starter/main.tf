variable "prefix" {
  type    = string
  default = "s8-course"
}

variable "unused_environment" {
  type    = string
  default = "development"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.prefix}-artifacts"

  tags = {
    Owner = ""
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_sqs_queue" "jobs" {
  name = "${var.prefix}-jobs"

  tags = {
    Owner = ""
  }
}

resource "aws_iam_role" "worker" {
  name = "${var.prefix}-worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "worker" {
  statement {
    actions   = ["*"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "${var.prefix}-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_eip" "unused" {
  domain = "vpc"
}

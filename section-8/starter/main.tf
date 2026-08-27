variable "prefix" {
  type    = string
  default = "s8-course"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.prefix}-artifacts"

  tags = {
    Owner = "course-platform-team"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_sqs_queue" "jobs" {
  name                    = "${var.prefix}-jobs"
  sqs_managed_sse_enabled = true

  tags = {
    Owner = "course-platform-team"
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
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "sqs:DeleteMessage",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
      aws_sqs_queue.jobs.arn,
    ]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "${var.prefix}-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

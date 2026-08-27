mock_provider "aws" {}

override_data {
  target = data.aws_iam_policy_document.worker
  values = {
    json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
  }
}

run "foundation_contract" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket_public_access_block.artifacts.block_public_acls &&
      aws_s3_bucket_public_access_block.artifacts.block_public_policy &&
      aws_s3_bucket_public_access_block.artifacts.ignore_public_acls &&
      aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets
    )
    error_message = "Artifact storage must block every public-access path."
  }

  assert {
    condition = (
      aws_s3_bucket.artifacts.tags["Owner"] != "" &&
      aws_sqs_queue.jobs.tags["Owner"] != ""
    )
    error_message = "Every cost-bearing resource needs a non-empty Owner tag."
  }
}

package main_test

import rego.v1
import data.main.deny

test_denies_public_access_controls if {
  result := deny with input as {
    "resource_changes": [{
      "address": "aws_s3_bucket_public_access_block.artifacts",
      "type": "aws_s3_bucket_public_access_block",
      "change": {"after": {"block_public_acls": false}}
    }]
  }
  count(result) == 1
}

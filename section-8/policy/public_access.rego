package main

import rego.v1

deny contains message if {
  some resource in input.resource_changes
  resource.type == "aws_s3_bucket_public_access_block"
  resource.change.after.acl == "public-read"
  message := sprintf("%s permits public access", [resource.address])
}

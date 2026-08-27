package main

import rego.v1

deny contains message if {
  some resource in input.resource_changes
  resource.type == "aws_s3_bucket_public_access_block"
  not resource.change.after.block_public_acls
  message := sprintf("%s does not block public ACLs", [resource.address])
}

deny contains message if {
  some resource in input.resource_changes
  resource.type == "aws_s3_bucket_public_access_block"
  not resource.change.after.block_public_policy
  message := sprintf("%s does not block public policies", [resource.address])
}

deny contains message if {
  some resource in input.resource_changes
  resource.type == "aws_s3_bucket_public_access_block"
  not resource.change.after.ignore_public_acls
  message := sprintf("%s does not ignore public ACLs", [resource.address])
}

deny contains message if {
  some resource in input.resource_changes
  resource.type == "aws_s3_bucket_public_access_block"
  not resource.change.after.restrict_public_buckets
  message := sprintf("%s does not restrict public buckets", [resource.address])
}

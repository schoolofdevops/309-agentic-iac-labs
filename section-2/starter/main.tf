terraform {
  required_version = ">= 1.14.0"
}

output "platform_name" {
  value = random_id.platform.hex
}

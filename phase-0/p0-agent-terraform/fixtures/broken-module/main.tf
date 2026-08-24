terraform {
  required_version = ">= 1.14.0"
}

resource "random_id" "platform" {
  byte_length = 1
}

output "platform_name" {
  value = random_id.platform.hex
}

terraform {
  required_version = ">= 1.14.0"

  required_providers {
    random = {
      source = "hashicorp/random"
    }
  }
}

resource "random_id" "platform" {
  byte_length = 4
}

output "platform_name" {
  value = random_id.platform.hex
}

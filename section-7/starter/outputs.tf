output "resource_prefix" {
  description = "Prefix used to identify the disposable local resources."
  value       = var.prefix
}

output "local_endpoint" {
  description = "Local connection endpoint used by the course lifecycle."
  value       = local.floci_endpoint
  sensitive   = true
}

output "queue_url" {
  description = "URL of the local job queue."
  value       = module.messaging.queue_url
}

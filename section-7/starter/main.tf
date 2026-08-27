module "storage" {
  source = "./modules/storage"
  prefix = var.prefix
}

module "messaging" {
  source                   = "./modules/messaging"
  prefix                   = var.prefix
  queue_visibility_timeout = var.queue_visibility_timeout
}

module "job_state" {
  source = "./modules/job-state"
  prefix = var.prefix
}

module "identity" {
  source     = "./modules/identity"
  prefix     = var.prefix
  bucket_arn = module.storage.bucket_arn
  queue_arn  = module.messaging.queue_arn
}

module "observability" {
  source = "./modules/observability"
  prefix = var.prefix
}

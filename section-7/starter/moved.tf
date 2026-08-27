moved {
  from = module.queue.aws_sqs_queue.jobs
  to   = module.messaging.aws_sqs_queue.jobs
}

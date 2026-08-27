output "queue_arn" {
  value = aws_sqs_queue.jobs.arn
}

output "queue_url" {
  value = aws_sqs_queue.jobs.url
}

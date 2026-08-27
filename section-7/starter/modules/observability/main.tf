resource "aws_cloudwatch_log_group" "worker" {
  name              = "/course/${var.prefix}/worker"
  retention_in_days = 7
}

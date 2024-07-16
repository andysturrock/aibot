terraform {
  required_providers {
    google = {
      configuration_aliases = [google]
    }
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS Account to allow access from"
}

variable "gcp_identity_project_id" {
  type        = string
  description = "GCP id for workload identity federation project"
}

variable "gcp_identity_project_number" {
  type        = string
  description = "GCP number for workload identity federation project"
}

variable "workload_identity_pool_id" {
  type        = string
  description = "Workload Identity Pool Id where the AWS role is mapped"
}

output "workload_identity_pool_id" {
  value = google_iam_workload_identity_pool.aws_aibot.workload_identity_pool_id
}
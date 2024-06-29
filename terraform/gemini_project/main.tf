terraform {
  required_providers {
    google = {
      configuration_aliases = [ google ]
    }
  }
}

variable "gcp_gemini_project_id" {
  type        = string
  description = "GCP id for Gemini project"
}

variable "gcp_identity_project_number" {
  type        = string
  description = "GCP number for workload identity federation project"
}

variable "aws_account_id" {
  type        = string
  description = "AWS Account to allow access from"
}

variable "workload_identity_pool_id" {
  type = string
  description = "Workload Identity Pool Id where the AWS role is mapped"
}
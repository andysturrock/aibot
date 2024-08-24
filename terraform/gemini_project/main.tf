terraform {
  required_providers {
    google = {
      configuration_aliases = [google]
    }
    google-beta = {
      configuration_aliases = [google-beta]
    }
  }
}

variable "gcp_gemini_project_id" {
  type        = string
  description = "GCP id for Gemini project"
}

variable "gcp_gemini_project_number" {
  type        = string
  description = "GCP project number for Gemini project"
}

variable "gcp_identity_project_number" {
  type        = string
  description = "GCP project number for workload identity federation project"
}

variable "aws_account_id" {
  type        = string
  description = "AWS Account to allow access from"
}

variable "workload_identity_pool_id" {
  type        = string
  description = "Workload Identity Pool Id where the AWS role is mapped"
}

variable "gcp_region" {
  type        = string
  description = "GCP region, eg europe-west2"
}
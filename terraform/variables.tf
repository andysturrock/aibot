variable "gcp_identity_project_id" {
  type        = string
  description = "GCP id for workload identity federation project"
}

variable "gcp_identity_project_number" {
  type        = string
  description = "GCP number for workload identity federation project"
}

variable "gcp_gemini_project_id" {
  type        = string
  description = "GCP id for Gemini project"
}

variable "gcp_identity_project_credentials" {
  type        = string
  sensitive   = true
  description = "GCP credentials for terraform service account for identity project"
}

variable "gcp_gemini_project_credentials" {
  type        = string
  sensitive   = true
  description = "GCP credentials for terraform service account for Gemini project"
}

variable "gcp_region" {
  type        = string
  description = "GCP region"
}

variable "gcp_zone" {
  type        = string
  description = "GCP zone"
}

variable "aws_account_id" {
  type        = string
  description = "AWS Account to allow access from"
}

variable "enable_gemini_apis" {
  type        = bool
  description = "Enable Gemini APIs"
}
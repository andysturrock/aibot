variable "gcp_gemini_project_id" {
  type        = string
  description = "GCP id for Gemini project"
}

variable "gcp_gemini_project_number" {
  type        = string
  description = "GCP project number for Gemini project"
}

variable "gcp_region" {
  type        = string
  description = "GCP region, eg europe-west2"
}

variable "gcp_bq_location" {
  type        = string
  description = "GCP BigQuery location, eg EU or europe-west2"
  default     = "EU"
}

variable "gcp_zone" {
  type        = string
  description = "GCP zone"
  default     = "europe-west2-a"
}

variable "custom_fqdn" {
  type        = string
  description = "Fully Qualified Domain Name (FQDN) for the Load Balancer (e.g. aibot.example.com)"
}

variable "iap_client_id" {
  type        = string
  description = "OAuth 2.0 Client ID for IAP"
  default     = "PLACEHOLDER"
}

variable "iap_client_secret" {
  type        = string
  description = "OAuth 2.0 Client Secret for IAP"
  default     = "PLACEHOLDER"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository in 'owner/repo' format (e.g. andysturrock/aibot)"
  default     = "andysturrock/aibot"
}

variable "log_level" {
  type        = string
  description = "Log level for all services (DEBUG, INFO, WARNING, ERROR)"
  default     = "INFO"
}

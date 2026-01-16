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

variable "gcp_zone" {
  type        = string
  description = "GCP zone"
  default     = "europe-west2-a"
}

variable "enable_gemini_apis" {
  type        = bool
  description = "Enable Gemini APIs"
  default     = true
}

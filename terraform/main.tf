terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project               = var.gcp_gemini_project_id
  region                = var.gcp_region
  zone                  = var.gcp_zone
  alias                 = "gemini_project"
  user_project_override = true
  billing_project       = var.gcp_gemini_project_id
}
provider "google-beta" {
  project               = var.gcp_gemini_project_id
  region                = var.gcp_region
  zone                  = var.gcp_zone
  alias                 = "gemini_project_beta"
  user_project_override = true
  billing_project       = var.gcp_gemini_project_id
}

module "gemini_project" {
  source = "./gemini_project"
  providers = {
    google      = google.gemini_project
    google-beta = google-beta.gemini_project_beta
  }
  gcp_region                = var.gcp_region
  gcp_gemini_project_id     = var.gcp_gemini_project_id
  gcp_gemini_project_number = var.gcp_gemini_project_number
}
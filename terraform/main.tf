terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.16"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.16"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "google" {
  project               = var.gcp_gemini_project_id
  region                = var.gcp_region
  zone                  = var.gcp_zone
  user_project_override = true
  billing_project       = var.gcp_gemini_project_id
}

provider "google-beta" {
  project               = var.gcp_gemini_project_id
  region                = var.gcp_region
  zone                  = var.gcp_zone
  user_project_override = true
  billing_project       = var.gcp_gemini_project_id
}

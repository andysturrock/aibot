terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "5.38.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "5.38.0"
    }
  }
}

provider "google" {
  project     = var.gcp_identity_project_id
  credentials = var.gcp_identity_project_credentials
  region      = var.gcp_region
  zone        = var.gcp_zone
  alias       = "identity_project"
}

provider "google" {
  project     = var.gcp_gemini_project_id
  credentials = var.gcp_gemini_project_credentials
  region      = var.gcp_region
  zone        = var.gcp_zone
  alias       = "gemini_project"
}
provider "google-beta" {
  project     = var.gcp_gemini_project_id
  credentials = var.gcp_gemini_project_credentials
  region      = var.gcp_region
  zone        = var.gcp_zone
  alias       = "gemini_project_beta"
}

module "identity_project" {
  source = "./identity_project"
  providers = {
    google = google.identity_project
  }
  aws_account_id              = var.aws_account_id
  gcp_identity_project_id     = var.gcp_identity_project_id
  gcp_identity_project_number = var.gcp_identity_project_number
  workload_identity_pool_id   = module.identity_project.workload_identity_pool_id
}

module "gemini_project" {
  source = "./gemini_project"
  providers = {
    google      = google.gemini_project
    google-beta = google-beta.gemini_project_beta
  }
  gcp_gemini_project_id       = var.gcp_gemini_project_id
  gcp_identity_project_number = var.gcp_identity_project_number
  aws_account_id              = var.aws_account_id
  workload_identity_pool_id   = module.identity_project.workload_identity_pool_id
}
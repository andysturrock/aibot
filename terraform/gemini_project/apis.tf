# Enable the Gemini API
resource "google_project_service" "gemini_api" {
  project = var.gcp_gemini_project_id
  service = "aiplatform.googleapis.com"
  // Don't disable this API when we run tf destroy.
  disable_on_destroy = false
}

# Enable the DiscoveryEngine API
resource "google_project_service" "discoveryengine_api" {
  project = var.gcp_gemini_project_id
  service = "discoveryengine.googleapis.com"
  // Don't disable this API when we run tf destroy.
  disable_on_destroy = false
}

# Enable the Cloud Scheduler API
resource "google_project_service" "cloudscheduler_api" {
  project = var.gcp_gemini_project_id
  service = "cloudscheduler.googleapis.com"
  // Don't disable this API when we run tf destroy.
  disable_on_destroy = false
}

# Enable the Cloud Run API
resource "google_project_service" "cloudrun_api" {
  project = var.gcp_gemini_project_id
  service = "run.googleapis.com"
  // Don't disable this API when we run tf destroy.
  disable_on_destroy = false
}

# Enable the Secret Manager API
resource "google_project_service" "secretmanager_api" {
  project = var.gcp_gemini_project_id
  service = "secretmanager.googleapis.com"
  // Don't disable this API when we run tf destroy.
  disable_on_destroy = false
}

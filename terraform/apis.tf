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

# Enable the Firestore API
resource "google_project_service" "firestore_api" {
  project = var.gcp_gemini_project_id
  service = "firestore.googleapis.com"
  // Don't disable this API when we run tf destroy.
  disable_on_destroy = false
}

# Enable the Artifact Registry API
resource "google_project_service" "artifactregistry_api" {
  project            = var.gcp_gemini_project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "certificatemanager_api" {
  project            = var.gcp_gemini_project_id
  service            = "certificatemanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap_api" {
  project            = var.gcp_gemini_project_id
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

# Enable IAM Credentials API (required for signJwt used by MCP proxy SA JWT auth)
resource "google_project_service" "iamcredentials_api" {
  project            = var.gcp_gemini_project_id
  service            = "iamcredentials.googleapis.com"
  disable_on_destroy = false
}

# Enable Cloud KMS API (required for token encryption key)
resource "google_project_service" "cloudkms_api" {
  project            = var.gcp_gemini_project_id
  service            = "cloudkms.googleapis.com"
  disable_on_destroy = false
}

resource "google_firestore_database" "database" {
  project     = var.gcp_gemini_project_id
  name        = "(default)"
  location_id = var.gcp_region
  type        = "FIRESTORE_NATIVE"
}

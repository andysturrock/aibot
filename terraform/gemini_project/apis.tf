# Enable the Gemini API
resource "google_project_service" "gemini_api" {
  project  = var.gcp_gemini_project_id
  service  = "aiplatform.googleapis.com"
  // Disable this API when we run tf destroy.
  disable_on_destroy = true
}
resource "google_project_iam_custom_role" "aibot_role" {
  project = var.gcp_gemini_project_id
  role_id = "aibot_role_${random_id.name_suffix.hex}"
  title   = "AIBot Gemini Role"

  permissions = [
    "aiplatform.endpoints.predict",
    "discoveryengine.servingConfigs.search",
    "storage.objects.create",
    "storage.objects.delete",
    "bigquery.tables.getData"
  ]
}

resource "google_project_iam_binding" "aibot_logic_custom_role_binding" {
  project = var.gcp_gemini_project_id
  role    = "projects/${var.gcp_gemini_project_id}/roles/${google_project_iam_custom_role.aibot_role.role_id}"
  members = [
    "serviceAccount:${google_service_account.aibot_logic.email}",
  ]
}

resource "google_project_iam_member" "aibot_logic_bigquery_data_viewer" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.dataViewer"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

resource "google_project_iam_member" "aibot_logic_bigquery_job_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

# The Compute Engine default service account needs the cloud builds builder role.
# It uses Cloud Build to create the container for the service.
resource "google_project_iam_member" "compute_service_account" {
  project = var.gcp_gemini_project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${var.gcp_gemini_project_number}-compute@developer.gserviceaccount.com"
}

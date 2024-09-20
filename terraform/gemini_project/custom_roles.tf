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

resource "google_project_iam_binding" "aibot_lambda_custom_role_binding" {
  project = var.gcp_gemini_project_id
  role    = "projects/${var.gcp_gemini_project_id}/roles/${google_project_iam_custom_role.aibot_role.role_id}"
  members = [
    "principal://iam.googleapis.com/projects/${var.gcp_identity_project_number}/locations/global/workloadIdentityPools/${var.workload_identity_pool_id}/subject/arn:aws:sts::${var.aws_account_id}:assumed-role/handlePromptCommandLambdaRole/AIBot-handlePromptCommandLambda",
  ]
}

resource "google_project_iam_member" "aibot_lambda_bigquery_data_viewer" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.dataViewer"
  member  = "principal://iam.googleapis.com/projects/${var.gcp_identity_project_number}/locations/global/workloadIdentityPools/${var.workload_identity_pool_id}/subject/arn:aws:sts::${var.aws_account_id}:assumed-role/handlePromptCommandLambdaRole/AIBot-handlePromptCommandLambda"
}

resource "google_project_iam_member" "aibot_lambda_bigquery_job_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.jobUser"
  member  = "principal://iam.googleapis.com/projects/${var.gcp_identity_project_number}/locations/global/workloadIdentityPools/${var.workload_identity_pool_id}/subject/arn:aws:sts::${var.aws_account_id}:assumed-role/handlePromptCommandLambdaRole/AIBot-handlePromptCommandLambda"
}

# The Compute Engine default service account needs the cloud builds builder role.
# It uses Cloud Build to create the container for the service.
resource "google_project_iam_member" "compute_service_account" {
  project = var.gcp_gemini_project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${var.gcp_gemini_project_number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_custom_role" "aibot_role" {
  project = var.gcp_gemini_project_id
  role_id = "aibot_role_${random_id.name_suffix.hex}"
  title   = "AIBot Gemini Role"

  permissions = [
    "aiplatform.endpoints.predict",
    "discoveryengine.servingConfigs.search",
    "storage.objects.create",
    "storage.objects.delete"
  ]
}

resource "google_project_iam_binding" "aibot_binding" {
  project = var.gcp_gemini_project_id
  role    = "projects/${var.gcp_gemini_project_id}/roles/${google_project_iam_custom_role.aibot_role.role_id}"
  members = [
    "principal://iam.googleapis.com/projects/${var.gcp_identity_project_number}/locations/global/workloadIdentityPools/${var.workload_identity_pool_id}/subject/arn:aws:sts::${var.aws_account_id}:assumed-role/handlePromptCommandLambdaRole/AIBot-handlePromptCommandLambda",
  ]
}

# The Compute Engine default service account needs the cloud builds builder role.
resource "google_project_iam_binding" "compute_service_account" {
  project = var.gcp_gemini_project_id
  role    = "roles/cloudbuild.builds.builder"
  members = [
    "serviceAccount:${var.gcp_gemini_project_number}-compute@developer.gserviceaccount.com",
  ]
}

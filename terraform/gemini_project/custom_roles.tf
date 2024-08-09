# Need to use a random suffix as GCP soft-deletes custom roles.
# So to be able to delete and recreate we need to use a different name each time.
resource "random_id" "role_name_suffix" {
  byte_length = 2
}

resource "google_project_iam_custom_role" "aibot_role" {
  project = var.gcp_gemini_project_id
  role_id = "aibot_role_${random_id.role_name_suffix.hex}"
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
    "principal://iam.googleapis.com/projects/${var.gcp_identity_project_number}/locations/global/workloadIdentityPools/${var.workload_identity_pool_id}/subject/arn:aws:sts::${var.aws_account_id}:assumed-role/handleSummariseCommandLambdaRole/AIBot-handleSummariseCommandLambda",
  ]
}


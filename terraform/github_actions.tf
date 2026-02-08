# --- GitHub Actions CI/CD Infrastructure ---

# Service Account for GitHub Actions
resource "google_service_account" "github_actions" {
  account_id   = "github-actions"
  display_name = "Service Account for GitHub Actions CI/CD"
}

# IAM Roles for Build and Deployment
resource "google_project_iam_member" "github_actions_editor" {
  project = var.gcp_gemini_project_id
  role    = "roles/editor"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_iap_admin" {
  project = var.gcp_gemini_project_id
  role    = "roles/iap.admin"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_pubsub_admin" {
  project = var.gcp_gemini_project_id
  role    = "roles/pubsub.admin"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_registry_writer" {
  project = var.gcp_gemini_project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_run_developer" {
  project = var.gcp_gemini_project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_datastore_owner" {
  project = var.gcp_gemini_project_id
  role    = "roles/datastore.owner"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# Allows the GitHub Actions SA to act as the individual service accounts of the Cloud Run services
resource "google_project_iam_member" "github_actions_sa_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# Explicitly grant storage access for Terraform state
resource "google_storage_bucket_iam_member" "github_actions_state_access" {
  bucket = "${var.gcp_gemini_project_id}-aibot-terraform-state"
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.github_actions.email}"
}

# --- 2026-02-08 Fix: CI/CD needs Project IAM Admin to manage IAM bindings via Terraform ---
resource "google_project_iam_member" "github_actions_iam_admin" {
  project = var.gcp_gemini_project_id
  role    = "roles/resourcemanager.projectIamAdmin"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# --- 2026-02-08 Fix: CI/CD needs Secret Manager Admin to manage secret IAM policies ---
resource "google_project_iam_member" "github_actions_secret_admin" {
  project = var.gcp_gemini_project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# --- 2026-02-08 Fix: CI/CD needs BigQuery Admin to manage table IAM policies ---
resource "google_project_iam_member" "github_actions_bigquery_admin" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.admin"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# --- Workload Identity Federation ---

resource "google_iam_workload_identity_pool" "github_pool" {
  workload_identity_pool_id = "github-actions-pool-v2"
  display_name              = "GitHub Actions Pool"
  description               = "Identity pool for GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github_provider" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Provider"
  description                        = "Workload Identity Pool Provider for GitHub Actions"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == '${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Bind the GitHub Actions SA to the WIF pool for the specific repository
resource "google_service_account_iam_member" "github_actions_wif_binding" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_pool.name}/attribute.repository/${var.github_repo}"
}

# --- Outputs for GitHub Secrets ---

output "github_actions_sa_email" {
  value = google_service_account.github_actions.email
}

output "github_actions_wif_provider" {
  value = google_iam_workload_identity_pool_provider.github_provider.name
}

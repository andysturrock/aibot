# --- Service IAM Configuration ---

resource "google_service_account" "collect_slack_messages" {
  # GCP account ids must match "^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])$".
  # So dashes rather than underscores as separators.
  account_id   = "collect-slack-messages"
  display_name = "Service Account for running collect_slack_messages function"
}

# Give the service account permission to invoke the function
data "google_iam_policy" "collect_slack_messages_run_invoker" {
  binding {
    role = "roles/run.invoker"
    members = [
      "serviceAccount:${google_service_account.collect_slack_messages.email}"
    ]
  }
}

# Give the service account permission to get the AIBot secret
resource "google_secret_manager_secret_iam_member" "collect_slack_messages_secrets" {
  secret_id = "AIBot"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}


# IAM for slack-collector Cloud Run service is handled in cloud_run.tf

# --- IAM for New Services ---

# Webhook needs to publish to Pub/Sub (already done in cloud_run.tf)

# MCP Slack Search needs to:
# 1. Use AI Platform (Vertex AI) for embeddings
resource "google_project_iam_member" "mcp_aiplatform_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.slack_search_mcp.email}"
}

# 2. Use BigQuery for vector search
resource "google_project_iam_member" "mcp_bq_jobuser" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.slack_search_mcp.email}"
}

resource "google_bigquery_dataset_iam_member" "mcp_bq_viewer" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.slack_search_mcp.email}"
}

# 3. Access Secrets (allowed team IDs, signing secret etc)
resource "google_secret_manager_secret_iam_member" "mcp_secrets" {
  secret_id = "AIBot"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.slack_search_mcp.email}"
}

# 2. Access Secrets (user tokens)
resource "google_secret_manager_secret_iam_member" "logic_secrets" {
  secret_id = "AIBot"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.aibot_logic.email}"
}

# Webhook Access to Secrets
resource "google_secret_manager_secret_iam_member" "webhook_secrets" {
  secret_id = "AIBot"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.aibot_webhook.email}"
}

# 2. Use AI Platform for the main LLM interaction
resource "google_project_iam_member" "logic_aiplatform_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

# 3. Use Firestore for token storage
resource "google_project_iam_member" "logic_firestore_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

resource "google_cloud_scheduler_job" "collect_slack_messages" {
  name        = "invoke-collect-slack-messages"
  description = "Schedule the HTTPS trigger for collect_slack_messages cloud function"
  schedule    = "*/20 * * * *" # every twenty minutes
  time_zone   = "Etc/GMT"
  project     = var.gcp_gemini_project_id
  region      = var.gcp_region

  http_target {
    uri         = google_cloud_run_v2_service.slack_collector.uri
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.collect_slack_messages.email
    }
  }

  # Removed depends_on and lifecycle blocks as function is now a Cloud Run service
}

resource "google_bigquery_dataset" "aibot_slack_messages" {
  dataset_id    = "aibot_slack_messages"
  friendly_name = "AI Bot Slack Messages"
  description   = "Slack messages for search by AI Bot"
  location      = var.gcp_bq_location
}

# Give the service account access to the dataset
resource "google_bigquery_dataset_iam_member" "aibot_slack_messages_bq_user" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  role       = "roles/bigquery.user"
  member     = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

# Give the service account read-write access to the slack_content table
resource "google_bigquery_table_iam_member" "aibot_slack_messages_slack_content_dataeditor" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  table_id   = google_bigquery_table.slack_content.table_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

# Give the service account read-write access to the slack_content_metadata table
resource "google_bigquery_table_iam_member" "aibot_slack_messages_slack_content_metadata_dataeditor" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  table_id   = google_bigquery_table.slack_content_metadata.table_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

# Allow the service account to create BQ jobs
resource "google_project_iam_member" "aibot_slack_messages_bq_jobuser" {
  project = var.gcp_gemini_project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

# Give the service account aiplatform.user role (which contains aiplatform.endpoints.predict permission)
# which is needed to create embeddings.
resource "google_project_iam_member" "aibot_slack_messages_aiplatform_user" {
  project = var.gcp_gemini_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

resource "google_bigquery_table" "slack_content" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  table_id   = "slack_content"

  schema = <<EOF
[
  {
    "name": "channel",
    "type": "STRING",
    "mode": "REQUIRED",
    "description": "Slack channel id"
  },
  {
    "name": "ts",
    "type": "FLOAT",
    "mode": "REQUIRED",
    "description": "Slack timestamp of the message"
  },
  {
    "name": "embeddings",
    "type": "FLOAT",
    "mode": "REPEATED",
    "description": "Embeddings for message text"
  }
]
EOF
}

resource "google_bigquery_table" "slack_content_metadata" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  table_id   = "slack_content_metadata"

  schema = <<EOF
[
  {
    "name": "channel_id",
    "type": "STRING",
    "mode": "REQUIRED",
    "description": "Slack channel id"
  },
  {
    "name": "channel_name",
    "type": "STRING",
    "mode": "REQUIRED",
    "description": "Slack channel name"
  },
  {
    "name": "created_datetime",
    "type": "DATETIME",
    "mode": "REQUIRED",
    "description": "Datetime channel was created"
  },
  {
    "name": "last_download_datetime",
    "type": "DATETIME",
    "mode": "REQUIRED",
    "description": "Last time channel content was downloaded"
  }
]
EOF
}

resource "random_id" "job_name_suffix" {
  keepers = {
    first = "${timestamp()}"
  }
  byte_length = 2
}

# Uncomment this when there are over 5000 rows in the table.  BQ won't let you create indexes on empty tables.
# resource "google_bigquery_job" "vector_index" {
#   job_id = "create_vector_index_${random_id.job_name_suffix.hex}"
#   query {
#     query          = "CREATE VECTOR INDEX embeddings ON ${google_bigquery_dataset.aibot_slack_messages.dataset_id}.${google_bigquery_table.slack_content.id}(embeddings) OPTIONS(index_type = 'IVF')"
#     use_legacy_sql = false
#   }
#   location = var.gcp_bq_location
# }

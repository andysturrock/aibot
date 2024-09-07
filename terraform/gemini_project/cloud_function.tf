resource "google_storage_bucket" "aibot_slack_messages" {
  name                        = "aibot_slack_messages_${random_id.name_suffix.hex}"
  location                    = "EU"
  uniform_bucket_level_access = true
  force_destroy               = true
}

resource "google_storage_bucket" "aibot_gcf_source" {
  name                        = "aibot_gcf_source_${random_id.name_suffix.hex}"
  location                    = "EU"
  uniform_bucket_level_access = true
  force_destroy               = true
}

# The zip files must have been created before running tf apply.
# Use the build_gcf_bundles.sh script to bundle the python source.
# Then when Terraform takes a snapshot of the filesystem for the apply
# stage it will include the zip files in the ./dist directory.
resource "google_storage_bucket_object" "collect_slack_messages_source_zip" {
  # The timestamp() in the name forces a rebuild.  Without it even if the source code changes the function won't be updated.
  # It's overly cautious as it will still rebuild the function even if the code hasn't changed, but
  # better cautious and slightly slow than not deploy changed functionality.
  name           = "handle_collect_slack_messages.${timestamp()}.zip"
  bucket         = google_storage_bucket.aibot_gcf_source.name
  source         = "${path.root}/dist/handle_collect_slack_messages.zip"
  detect_md5hash = true
}

resource "google_cloudfunctions2_function" "collect_slack_messages" {
  # Use kebab case for the name rather than snake case so the generated Cloud Run service
  # has the same name (Cloud Run name are always kebab case).
  # See https://github.com/hashicorp/terraform-provider-google/issues/15264#issuecomment-2000050883
  name        = "collect-slack-messages"
  location    = var.gcp_region
  description = "Run on a schedule to collect messages from Slack public channels."

  build_config {
    runtime     = "python312"
    entry_point = "handle_collect_slack_messages"
    source {
      storage_source {
        bucket = google_storage_bucket.aibot_gcf_source.name
        object = google_storage_bucket_object.collect_slack_messages_source_zip.name
      }
    }
  }
  service_config {
    max_instance_count    = 1
    available_memory      = "256M"
    timeout_seconds       = 360
    service_account_email = google_service_account.collect_slack_messages.email
  }
}

resource "google_service_account" "collect_slack_messages" {
  # GCP account ids must match "^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])$".
  # So dashes rather than underscores as separators.
  account_id   = "collect-slack-messages"
  display_name = "Service Account for running collect_slack_messages function"
}

data "google_iam_policy" "collect_slack_messages" {
  binding {
    role = "roles/run.invoker"
    members = [
      "serviceAccount:${google_service_account.collect_slack_messages.email}"
    ]
  }
}

resource "google_cloud_run_service_iam_policy" "collect_slack_messages" {
  # This is the bit where we need the cloud function name and cloud run service name to match.
  # Note we use the function name in the service section and this is a google_cloud_run_service_iam_policy resource.
  service     = google_cloudfunctions2_function.collect_slack_messages.name
  policy_data = data.google_iam_policy.collect_slack_messages.policy_data
  depends_on  = [google_cloudfunctions2_function.collect_slack_messages]

  lifecycle {
    replace_triggered_by = [google_cloudfunctions2_function.collect_slack_messages]
  }
}

resource "google_cloud_scheduler_job" "collect_slack_messages" {
  name        = "invoke-collect-slack-messages"
  description = "Schedule the HTTPS trigger for collect_slack_messages cloud function"
  schedule    = "*/20 * * * *" # every twenty minutes
  time_zone   = "Etc/GMT"
  project     = google_cloudfunctions2_function.collect_slack_messages.project
  region      = google_cloudfunctions2_function.collect_slack_messages.location

  http_target {
    uri = "https://collect-slack-messages-${var.gcp_gemini_project_number}.${var.gcp_region}.run.app"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.collect_slack_messages.email
    }
  }

  # Needs this otherwise the function is replaced (changing its URL) and this doesn't get updated to match.
  depends_on = [google_cloudfunctions2_function.collect_slack_messages]
  lifecycle {
    replace_triggered_by = [google_cloudfunctions2_function.collect_slack_messages]
  }
}



resource "google_bigquery_dataset" "aibot_slack_messages" {
  dataset_id                  = "aibot_slack_messages"
  friendly_name               = "AI Bot Slack Messages"
  description                 = "Slack messages for search by AI Bot"
  location                    = "EU"
}

resource "google_bigquery_table" "slack_content" {
  dataset_id = google_bigquery_dataset.aibot_slack_messages.dataset_id
  table_id   = "slack_content"

  schema = <<EOF
[
  {
    "name": "workspace",
    "type": "STRING",
    "mode": "REQUIRED",
    "description": "Slack workspace id"
  },
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
    "name": "text",
    "type": "STRING",
    "mode": "REQUIRED",
    "description": "Text of Slack message"
  },
  {
    "name": "embeddings",
    "type": "FLOAT",
    "mode": "REPEATED",
    "description": "Embeddings for content"
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

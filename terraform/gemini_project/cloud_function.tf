resource "google_storage_bucket" "aibot_gcf_source" {
  name                        = "aibot_gcf_source_${random_id.name_suffix.hex}"
  location                    = "EU"
  uniform_bucket_level_access = true
}

# The zip files must have been created before running tf apply
resource "google_storage_bucket_object" "collect_slack_messages_source_zip" {
  name   = "collect_slack_messages.zip"
  bucket = google_storage_bucket.aibot_gcf_source.name
  source = "${path.root}/dist/collect_slack_messages.zip"
}

resource "google_cloudfunctions2_function" "collect_slack_messages" {
  name        = "collect_slack_messages"
  location    = "${var.gcp_region}"
  description = "Run on a schedule to collect messages from Slack public channels."

  build_config {
    runtime     = "python312"
    entry_point = "http"
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

resource "google_cloudfunctions2_function_iam_member" "collect_slack_messages" {
  project        = google_cloudfunctions2_function.collect_slack_messages.project
  location       = google_cloudfunctions2_function.collect_slack_messages.location
  cloud_function = google_cloudfunctions2_function.collect_slack_messages.name
  role           = "roles/cloudfunctions.invoker"
  member         = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

resource "google_cloud_scheduler_job" "collect_slack_messages" {
  name        = "invoke-gcf-function"
  description = "Schedule the HTTPS trigger for cloud function"
  schedule    = "*/20 * * * *" # every twenty minutes
  project     = google_cloudfunctions2_function.collect_slack_messages.project
  region      = google_cloudfunctions2_function.collect_slack_messages.location

  http_target {
    uri         = google_cloudfunctions2_function.collect_slack_messages.service_config[0].uri
    http_method = "POST"
    oidc_token {
      audience              = "${google_cloudfunctions2_function.collect_slack_messages.service_config[0].uri}/"
      service_account_email = google_service_account.collect_slack_messages.email
    }
  }
}
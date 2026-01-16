# --- Service A: aibot-webhook ---

resource "google_cloud_run_v2_service" "aibot_webhook" {
  name     = "aibot-webhook"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }
    containers {
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_gemini_project_id}/aibot-images/aibot-logic:latest"
      env {
        name  = "TOPIC_ID"
        value = google_pubsub_topic.slack_events.name
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.gcp_gemini_project_id
      }
    }
    service_account = google_service_account.aibot_webhook.email
  }
}

resource "google_service_account" "aibot_webhook" {
  account_id   = "aibot-webhook"
  display_name = "Service Account for Slack Webhook"
}

# Allow Webhook to publish to the Topic
resource "google_pubsub_topic_iam_member" "webhook_publisher" {
  topic  = google_pubsub_topic.slack_events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.aibot_webhook.email}"
}

# --- Pub/Sub Messaging ---

resource "google_pubsub_topic" "slack_events" {
  name = "slack-events"
}

resource "google_pubsub_subscription" "logic_worker" {
  name  = "logic-worker-sub"
  topic = google_pubsub_topic.slack_events.name

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.aibot_logic.uri}/pubsub/worker"
    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
    }
  }
}

resource "google_service_account" "pubsub_invoker" {
  account_id   = "pubsub-invoker"
  display_name = "Service Account for Pub/Sub Push to Cloud Run"
}

# --- Service B: aibot-logic ---

resource "google_cloud_run_v2_service" "aibot_logic" {
  name     = "aibot-logic"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_gemini_project_id}/aibot-images/aibot-logic:latest"
      env {
        name  = "MCP_SEARCH_URL"
        value = google_cloud_run_v2_service.mcp_slack_search.uri
      }
      env {
        name  = "GCP_LOCATION"
        value = var.gcp_region
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.gcp_gemini_project_id
      }
    }
    service_account = google_service_account.aibot_logic.email
  }
}

resource "google_service_account" "aibot_logic" {
  account_id   = "aibot-logic"
  display_name = "Service Account for Bot Logic"
}

# Allow Pub/Sub to invoke the Logic service
resource "google_cloud_run_v2_service_iam_member" "pubsub_logic_invoker" {
  location = google_cloud_run_v2_service.aibot_logic.location
  name     = google_cloud_run_v2_service.aibot_logic.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_invoker.email}"
}

# --- Service C: mcp-slack-search (Python) ---

resource "google_cloud_run_v2_service" "mcp_slack_search" {
  name     = "mcp-slack-search"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_gemini_project_id}/aibot-images/slack-search-mcp:latest"
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.gcp_gemini_project_id
      }
      env {
        name  = "GCP_LOCATION"
        value = var.gcp_region
      }
    }
    service_account = google_service_account.mcp_slack_search.email
  }
}

resource "google_service_account" "mcp_slack_search" {
  account_id   = "mcp-slack-search"
  display_name = "Service Account for MCP Slack Search"
}

# Allow aibot-logic to invoke mcp-slack-search
resource "google_cloud_run_v2_service_iam_member" "logic_mcp_invoker" {
  location = google_cloud_run_v2_service.mcp_slack_search.location
  name     = google_cloud_run_v2_service.mcp_slack_search.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.aibot_logic.email}"
}

# --- Service D: slack-collector (Python) ---

resource "google_cloud_run_v2_service" "slack_collector" {
  name     = "slack-collector"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_gemini_project_id}/aibot-images/slack-collector:latest"
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.gcp_gemini_project_id
      }
    }
    service_account = google_service_account.collect_slack_messages.email
  }
}

# Allow Scheduler to invoke slack-collector
resource "google_cloud_run_v2_service_iam_member" "scheduler_collector_invoker" {
  location = google_cloud_run_v2_service.slack_collector.location
  name     = google_cloud_run_v2_service.slack_collector.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.collect_slack_messages.email}"
}

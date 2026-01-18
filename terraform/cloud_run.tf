# --- Service A: aibot-webhook ---

resource "google_cloud_run_v2_service" "aibot_webhook" {
  name                = "aibot-webhook"
  location            = var.gcp_region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

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
        name  = "LOG_LEVEL"
        value = "DEBUG"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.gcp_gemini_project_id
      }
      env {
        name  = "GCP_LOCATION"
        value = var.gcp_region
      }
    }
    service_account = google_service_account.aibot_webhook.email
  }
}

# Allow unauthenticated access (Protected by Load Balancer/Cloud Armor)
resource "google_cloud_run_v2_service_iam_member" "webhook_public_invoker" {
  location = google_cloud_run_v2_service.aibot_webhook.location
  name     = google_cloud_run_v2_service.aibot_webhook.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_service_account" "aibot_webhook" {
  account_id   = "aibot-webhook"
  display_name = "Service Account for Slack Webhook"
}

resource "google_project_iam_member" "webhook_secrets" {
  project = var.gcp_gemini_project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.aibot_webhook.email}"
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
  name                = "aibot-logic"
  location            = var.gcp_region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_gemini_project_id}/aibot-images/aibot-logic:latest"
      env {
        name  = "MCP_SEARCH_URL"
        value = google_cloud_run_v2_service.slack_search_mcp.uri
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

# Allow unauthenticated access (Protected by IAP on the Load Balancer)
resource "google_cloud_run_v2_service_iam_member" "logic_public_invoker" {
  location = google_cloud_run_v2_service.aibot_logic.location
  name     = google_cloud_run_v2_service.aibot_logic.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_service_account" "aibot_logic" {
  account_id   = "aibot-logic"
  display_name = "Service Account for Bot Logic"
}

resource "google_project_iam_member" "logic_secrets" {
  project = var.gcp_gemini_project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

resource "google_project_iam_member" "logic_firestore" {
  project = var.gcp_gemini_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

resource "google_project_iam_member" "logic_vertex" {
  project = var.gcp_gemini_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.aibot_logic.email}"
}

# Allow Pub/Sub to invoke the Logic service
resource "google_cloud_run_v2_service_iam_member" "pubsub_logic_invoker" {
  location = google_cloud_run_v2_service.aibot_logic.location
  name     = google_cloud_run_v2_service.aibot_logic.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_invoker.email}"
}

# --- Service C: mcp-slack-search (Python) ---

resource "google_cloud_run_v2_service" "slack_search_mcp" {
  name                = "slack-search-mcp"
  location            = var.gcp_region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

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
    service_account = google_service_account.slack_search_mcp.email
  }
}

# Allow unauthenticated access (Protected by IAP on the Load Balancer)
resource "google_cloud_run_v2_service_iam_member" "mcp_public_invoker" {
  location = google_cloud_run_v2_service.slack_search_mcp.location
  name     = google_cloud_run_v2_service.slack_search_mcp.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_service_account" "slack_search_mcp" {
  account_id   = "slack-search-mcp"
  display_name = "Service Account for Slack Search MCP"
}

# Allow aibot-logic to invoke slack-search-mcp
resource "google_cloud_run_v2_service_iam_member" "logic_mcp_invoker" {
  location = google_cloud_run_v2_service.slack_search_mcp.location
  name     = google_cloud_run_v2_service.slack_search_mcp.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.aibot_logic.email}"
}

# --- Service D: slack-collector (Python) ---

resource "google_cloud_run_v2_service" "slack_collector" {
  name                = "slack-collector"
  location            = var.gcp_region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"

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

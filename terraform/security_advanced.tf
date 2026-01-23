# --- Cloud Armor Security Policy ---
data "google_project" "project" {
}


resource "google_compute_security_policy" "aibot_policy" {
  name        = "aibot-security-policy"
  description = "Security policy for AIBot public endpoints"

  # Rule 0: Allow Slack event endpoints (Bypass WAF)
  # Slack payloads are JSON and often contain characters that trigger SQLi/XSS false positives.
  # We verify signatures in the application, so bypassing WAF for these specific paths is safe.
  rule {
    action   = "allow"
    priority = "500"
    match {
      expr {
        expression = "request.path.startsWith('/slack/')"
      }
    }
    description = "Allow Slack events and interactivity (Bypass WAF)"
  }

  # Rule 2: WAF Rules (SQLi, XSS, etc.)
  rule {
    action   = "deny(403)"
    priority = "1000"
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-v33-stable')"
      }
    }
    description = "WAF: SQL injection protection"
  }

  rule {
    action   = "deny(403)"
    priority = "1001"
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-v33-stable')"
      }
    }
    description = "WAF: XSS protection"
  }

  # Rule 3: Allow remaining expected paths and health checks (High Priority to bypass WAF)
  # Paths like /auth/ often contain parameters that trigger WAF false positives.
  rule {
    action   = "allow"
    priority = "600"
    match {
      expr {
        expression = "request.path.matches('/auth/.*') || request.path.matches('/mcp/.*') || request.path.matches('/health') || request.path.matches('/_gcp_iap/.*')"
      }
    }
    description = "Allow critical application paths (Bypass WAF)"
  }

  # Default rule: Deny all (Principle of Deny by Default)
  rule {
    action   = "deny(403)"
    priority = "2147483647"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default: Deny all"
  }
}

# --- Load Balancer & IAP for MCP Search ---

# 1. Serverless Network Endpoint Group (NEG)
resource "google_compute_region_network_endpoint_group" "mcp_neg" {
  name                  = "slack-search-mcp-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.gcp_region
  cloud_run {
    service = google_cloud_run_v2_service.slack_search_mcp.name
  }
}

# 2. Backend Service with IAP
resource "google_compute_backend_service" "mcp_backend" {
  name                  = "slack-search-mcp-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group = google_compute_region_network_endpoint_group.mcp_neg.id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }

  security_policy = google_compute_security_policy.aibot_policy.id

  iap {
    enabled              = true
    oauth2_client_id     = var.iap_client_id
    oauth2_client_secret = var.iap_client_secret
  }
}

# Allow aibot-logic to access this IAP-protected backend
resource "google_iap_web_backend_service_iam_member" "mcp_iap_access" {
  project             = var.gcp_gemini_project_id
  web_backend_service = google_compute_backend_service.mcp_backend.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = "serviceAccount:${google_service_account.aibot_logic.email}"
}

resource "google_iap_web_backend_service_iam_member" "mcp_iap_access_user" {
  project             = var.gcp_gemini_project_id
  web_backend_service = google_compute_backend_service.mcp_backend.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = "user:andy.sturrock@atombank.co.uk"
}

# Ensure the IAP Service Agent exists
resource "google_project_service_identity" "iap_sa" {
  provider = google-beta
  project  = var.gcp_gemini_project_id
  service  = "iap.googleapis.com"
}

# Grant the IAP service account permission to invoke the Cloud Run service
resource "google_cloud_run_v2_service_iam_member" "mcp_iap_invoker" {
  location = google_cloud_run_v2_service.slack_search_mcp.location
  name     = google_cloud_run_v2_service.slack_search_mcp.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_project_service_identity.iap_sa.email}"
}

# 3. Backend Service for Webhook (No IAP)
resource "google_compute_region_network_endpoint_group" "webhook_neg" {
  name                  = "aibot-webhook-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.gcp_region
  cloud_run {
    service = google_cloud_run_v2_service.aibot_webhook.name
  }
}

resource "google_compute_backend_service" "webhook_backend" {
  name                  = "aibot-webhook-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group = google_compute_region_network_endpoint_group.webhook_neg.id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }

  security_policy = google_compute_security_policy.aibot_policy.id
}

# 4. URL Map and Routing
resource "google_compute_url_map" "aibot_lb" {
  name            = "aibot-load-balancer"
  default_service = google_compute_backend_service.webhook_backend.id

  host_rule {
    hosts        = ["*"]
    path_matcher = "allpaths"
  }

  path_matcher {
    name            = "allpaths"
    default_service = google_compute_backend_service.webhook_backend.id

    path_rule {
      paths   = ["/mcp/*"]
      service = google_compute_backend_service.mcp_backend.id
    }
  }
}

# --- 5. Global IP and SSL Certificate ---

resource "google_compute_global_address" "aibot_lb_ip" {
  name = "aibot-lb-ip"
}

# Standardizing on Modern Certificate Manager as it's the "best" approach for GCP.
resource "google_certificate_manager_certificate" "aibot_cert" {
  name        = "aibot-cert"
  description = "AIBot managed certificate via Certificate Manager"
  scope       = "DEFAULT"
  managed {
    domains = [var.custom_fqdn]
  }
}

resource "google_certificate_manager_certificate_map" "aibot_cert_map" {
  name        = "aibot-cert-map"
  description = "AIBot certificate map"
}

resource "google_certificate_manager_certificate_map_entry" "aibot_cert_map_entry" {
  name         = "aibot-cert-map-entry"
  description  = "AIBot cert map entry"
  map          = google_certificate_manager_certificate_map.aibot_cert_map.name
  certificates = [google_certificate_manager_certificate.aibot_cert.id]
  hostname     = var.custom_fqdn
}

# --- 6. HTTP(S) Forwarding Componentry ---

resource "google_compute_target_https_proxy" "aibot_proxy" {
  name            = "aibot-https-proxy"
  url_map         = google_compute_url_map.aibot_lb.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.aibot_cert_map.id}"
}

resource "google_compute_global_forwarding_rule" "aibot_forwarding_rule" {
  name                  = "aibot-forwarding-rule"
  target                = google_compute_target_https_proxy.aibot_proxy.id
  port_range            = "443"
  ip_address            = google_compute_global_address.aibot_lb_ip.address
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Output the IP so the user can create the A record
output "load_balancer_ip" {
  value = google_compute_global_address.aibot_lb_ip.address
}

# --- Service-Specific Secrets (JSON Payloads) ---

# 1. aibot-logic-config
resource "google_secret_manager_secret" "logic_config" {
  secret_id = "aibot-logic-config"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_version" "logic_config" {
  secret = google_secret_manager_secret.logic_config.id
  secret_data = jsonencode({
    slackBotToken          = "REPLACE_ME"
    slackSigningSecret     = "REPLACE_ME"
    slackClientId          = "REPLACE_ME"
    slackClientSecret      = "REPLACE_ME"
    teamIdsForSearch       = "REPLACE_ME"
    enterpriseIdsForSearch = "REPLACE_ME"
    mcpSlackSearchUrl      = "https://${var.custom_fqdn}/mcp"
  })

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# 2. aibot-webhook-config
resource "google_secret_manager_secret" "webhook_config" {
  secret_id = "aibot-webhook-config"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_version" "webhook_config" {
  secret = google_secret_manager_secret.webhook_config.id
  secret_data = jsonencode({
    placeholder = "managed_by_deploy_sh"
  })

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# 3. AIBot-shared-config (Unified shared secrets)
resource "google_secret_manager_secret" "shared_config" {
  secret_id = "AIBot-shared-config"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_version" "shared_config" {
  secret = google_secret_manager_secret.shared_config.id
  secret_data = jsonencode({
    placeholder = "managed_by_deploy_sh"
  })

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# Grant all services access to the shared secret
resource "google_secret_manager_secret_iam_member" "shared_secret_access" {
  for_each = toset([
    "serviceAccount:${google_service_account.aibot_webhook.email}",
    "serviceAccount:${google_service_account.aibot_logic.email}",
    "serviceAccount:${google_service_account.slack_search_mcp.email}",
    "serviceAccount:${google_service_account.collect_slack_messages.email}"
  ])
  secret_id = google_secret_manager_secret.shared_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# 4. mcp-slack-search-config
resource "google_secret_manager_secret" "mcp_config" {
  secret_id = "slack-search-mcp-config"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_version" "mcp_config" {
  secret = google_secret_manager_secret.mcp_config.id
  secret_data = jsonencode({
    teamIdsForSearch       = "REPLACE_ME"
    enterpriseIdsForSearch = "REPLACE_ME"
    iapClientId            = var.iap_client_id
    iapClientSecret        = var.iap_client_secret
    iapAudience            = "/projects/${data.google_project.project.number}/global/backendServices/${google_compute_backend_service.mcp_backend.generated_id}"
  })

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# 4. slack-collector-config
resource "google_secret_manager_secret" "collector_config" {
  secret_id = "slack-collector-config"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_version" "collector_config" {
  secret = google_secret_manager_secret.collector_config.id
  secret_data = jsonencode({
    slackUserToken         = "REPLACE_ME"
    teamIdsForSearch       = "REPLACE_ME"
    enterpriseIdsForSearch = "REPLACE_ME"
  })

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# --- Outputs for deploy.sh ---

output "mcp_search_url" {
  value = "https://${var.custom_fqdn}/mcp"
}

output "webhook_url" {
  value = "https://${var.custom_fqdn}/slack/events"
}

output "logic_secret_name" {
  value = google_secret_manager_secret.logic_config.secret_id
}

output "mcp_secret_name" {
  value = google_secret_manager_secret.mcp_config.secret_id
}

output "custom_fqdn_output" {
  value = var.custom_fqdn
}

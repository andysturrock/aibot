# --- Cloud Armor Security Policy ---
data "google_project" "project" {
}


resource "google_compute_security_policy" "aibot_policy" {
  provider    = google-beta
  name        = "aibot-security-policy"
  description = "Security policy for AIBot public endpoints"

  # --- SEC-004: Surgical WAF Exclusions (No Broad Allows) ---

  # 1. Global Protections (Applies to EVERYONE, including Slack)
  rule {
    action   = "deny(403)"
    priority = "100"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable')"
      }
    }
    description = "WAF: Full XSS protection (Global)"
  }

  rule {
    action   = "deny(403)"
    priority = "101"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('lfi-v33-stable')"
      }
    }
    description = "WAF: Full LFI protection (Global)"
  }

  rule {
    action   = "deny(403)"
    priority = "102"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('rce-v33-stable')"
      }
    }
    description = "WAF: Full RCE protection (Global)"
  }

  rule {
    action   = "deny(403)"
    priority = "103"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('scannerdetection-v33-stable')"
      }
    }
    description = "WAF: Block security scanners (Global)"
  }

  rule {
    action   = "deny(403)"
    priority = "104"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('protocolattack-v33-stable')"
      }
    }
    description = "WAF: Block malformed protocol attacks (Global)"
  }

  # 2. Slack-Specific SQLi Protection (With Surgical Exclusion)
  # This rule ensures Slack traffic is protected by SQLi rules, but permits the 942200 false positive.
  # We restrict this rule to specific Slack POST endpoints to minimize the exception surface.
  rule {
    action   = "deny(403)"
    priority = "499"
    match {
      expr {
        expression = "request.method == 'POST' && request.path.matches('/slack/(?:events|interactivity)') && (origin.asn == 16509 || origin.asn == 14618) && has(request.headers['user-agent']) && request.headers['user-agent'].contains('Slackbot') && evaluatePreconfiguredWaf('sqli-v33-stable')"
      }
    }
    description = "WAF: Surgical SQLi protection for Slack traffic (Excl. 942200)"

    preconfigured_waf_config {
      exclusion {
        target_rule_set = "sqli-v33-stable"
        target_rule_ids = ["owasp-crs-v030301-id942200-sqli"]
      }
    }
  }

  # 3. Global SQLi Protection (Excludes Slack traffic checked above)
  # All other traffic (including Slack installation flows) gets full SQLi protection.
  rule {
    action   = "deny(403)"
    priority = "500"
    match {
      expr {
        expression = "!(request.method == 'POST' && request.path.matches('/slack/(?:events|interactivity)') && (origin.asn == 16509 || origin.asn == 14618) && has(request.headers['user-agent']) && request.headers['user-agent'].contains('Slackbot')) && evaluatePreconfiguredWaf('sqli-v33-stable')"
      }
    }
    description = "WAF: Full SQLi protection (Global, non-Slack)"
  }

  # Rule 2: Path-based Allow Rules - Priority 1000+
  # These now only trigger IF the request passed the WAF checks above.

  # Strict Allow for Slack Identity
  # Enforce POST method for events and interactivity.
  rule {
    action   = "allow"
    priority = "1000"
    match {
      expr {
        expression = "request.method == 'POST' && request.path.matches('/slack/(?:events|interactivity)') && (origin.asn == 16509 || origin.asn == 14618) && has(request.headers['user-agent']) && request.headers['user-agent'].contains('Slackbot')"
      }
    }
    description = "Strict Allow: POST verified Slack events/interactivity only"
  }

  # Specific Allow for Application Paths (Enforcing Methods)
  # We audit the exact verbs required: POST for messages, GET for auth and health.
  rule {
    action   = "allow"
    priority = "1001"
    match {
      expr {
        expression = "(request.method == 'GET' && request.path.matches('/slack/(?:install|oauth-redirect)')) || (request.method == 'GET' && request.path.matches('/auth/(?:login|callback)')) || (request.method == 'GET' && request.path == '/mcp/sse') || (request.method == 'POST' && request.path.matches('/mcp/messages/?')) || (request.method == 'GET' && (request.path == '/health' || request.path.matches('/_gcp_iap/(?:authenticate|clear_login_cookie|sessioninfo)')))"
      }
    }
    description = "Hardened Allow: Explicit paths & methods (No wildcards)"
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

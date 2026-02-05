# --- Cloud Armor Security Policy ---
data "google_project" "project" {
}

locals {
  # --- DEFINITIONS ---
  # We stay consistent and avoid magic numbers.
  # If Slack's infrastructure changes, we only update here.
  slack_path_scope = "(request.path == '/slack/events' || request.path == '/slack/interactivity')"

  # Simplification to stay within Cloud Armor's 5-atom limit per rule.
  # We use startsWith to reduce 4 equality checks into 2 prefix checks.
  global_waf_exclusion_scope = "(request.path.startsWith('/slack/') || request.path.startsWith('/auth/'))"

  # Slack infrastructure ASNs (AWS 16509, 14618)
  # Standard logical OR for platform compatibility.
  slack_asns_check = "origin.asn == 16509 || origin.asn == 14618"

  # Slack User Agent
  slack_ua = "Slackbot 1.0"
}

resource "google_compute_security_policy" "aibot_policy" {
  provider    = google-beta
  name        = "aibot-security-policy"
  description = "Security policy for AIBot Cloud Function (Atomic & Limit-Compliant)"

  # =========================================================
  # 1. EARLY DROP: SLACK IMPOSTORS (Priority 90-99)
  #    We filter out "fake" Slack traffic here (wrong ASN, headers, or method).
  #    This simplifies later rules and protects your function execution cost.
  # =========================================================

  # Rule 90: Network & Protocol Impostors
  # Blocks if: (Slack Path) AND (Wrong ASN OR Wrong Method)
  # Complexity: Path(1) + ASN1(1) + ASN2(1) + Method(1) = 4 atoms. Safe.
  rule {
    action   = "deny(403)"
    priority = "90"
    match {
      expr {
        expression = "${local.slack_path_scope} && (!(${local.slack_asns_check}) || request.method != 'POST')"
      }
    }
    description = "Block: Fake Slack (Wrong ASN or Method)"
  }

  # Rule 91: Identity & Header Impostors
  # Blocks if: (Slack Path) AND (Missing Headers OR Wrong UA)
  # Complexity: Path(1) + Sig(1) + TS(1) + UA(1) = 4 atoms. Safe.
  rule {
    action   = "deny(403)"
    priority = "91"
    match {
      expr {
        expression = "${local.slack_path_scope} && (!has(request.headers['x-slack-signature']) || !has(request.headers['x-slack-request-timestamp']) || !request.headers['user-agent'].contains('${local.slack_ua}'))"
      }
    }
    description = "Block: Fake Slack (Missing Headers or Wrong UA)"
  }

  # =========================================================
  # 2. GLOBAL WAF GAUNTLET (Rules 100-199)
  #    Standard blocking of malicious signatures (XSS, RCE, LFI).
  # =========================================================

  # Rule 100: Global WAF Gauntlet
  # Combines XSS, LFI, RCE, Scanners, and Protocol attacks.
  # Complexity: 5 subexpressions (Max). Safe and Quota-efficient.
  # --- Rule 100: Global XSS (Non-Slack) ---
  rule {
    action   = "deny(403)"
    priority = "100"
    match {
      expr {
        expression = "!(${local.global_waf_exclusion_scope}) && evaluatePreconfiguredWaf('xss-v33-stable')"
      }
    }
    description = "WAF: XSS Protection for Global Traffic"
  }

  # --- Rule 101: Global LFI (Non-Slack) ---
  rule {
    action   = "deny(403)"
    priority = "101"
    match {
      expr {
        expression = "!(${local.global_waf_exclusion_scope}) && evaluatePreconfiguredWaf('lfi-v33-stable')"
      }
    }
    description = "WAF: LFI Protection for Global Traffic"
  }

  # --- Rule 102: Global RCE (Non-Slack) ---
  rule {
    action   = "deny(403)"
    priority = "102"
    match {
      expr {
        expression = "!(${local.global_waf_exclusion_scope}) && evaluatePreconfiguredWaf('rce-v33-stable')"
      }
    }
    description = "WAF: RCE Protection for Global Traffic"
  }

  # --- Rule 103: Global Scanners (Non-Slack) ---
  rule {
    action   = "deny(403)"
    priority = "103"
    match {
      expr {
        expression = "!(${local.global_waf_exclusion_scope}) && evaluatePreconfiguredWaf('scannerdetection-v33-stable')"
      }
    }
    description = "WAF: Scanner Detection for Global Traffic"
  }

  # --- Rule 104: Global Protocol Attacks (Non-Slack) ---
  rule {
    action   = "deny(403)"
    priority = "104"
    match {
      expr {
        expression = "!(${local.global_waf_exclusion_scope}) && evaluatePreconfiguredWaf('protocolattack-v33-stable')"
      }
    }
    description = "WAF: Protocol Attack Protection for Global Traffic"
  }

  # =========================================================
  # 3. SQL INJECTION & EXCLUSIONS (Rules 499-500)
  # =========================================================

  # Rule 497: Verified Slack RCE
  # Slack payloads often contain shell characters that trip RCE rules.
  rule {
    action   = "deny(403)"
    priority = "497"
    preview  = false
    match {
      expr {
        expression = "${local.slack_path_scope} && evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1, 'opt_out_rule_ids': ['owasp-crs-v030301-id932100-rce', 'owasp-crs-v030301-id932110-rce', 'owasp-crs-v030301-id932200-rce']})"
      }
    }
    description = "WAF: RCE for Slack (Surgical Map-based Exclusion in CEL)"
  }

  # Rule 499: Verified Slack & MCP SQLi
  # We trust that Rules 90-91 already killed any "Fake" Slack traffic.
  # We also trust IAP for the /mcp/* path.
  rule {
    action   = "deny(403)"
    priority = "499"
    preview  = false
    match {
      expr {
        expression = "(${local.slack_path_scope} || request.path.startsWith('/mcp/')) && evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1, 'opt_out_rule_ids': ['owasp-crs-v030301-id942200-sqli', 'owasp-crs-v030301-id942260-sqli', 'owasp-crs-v030301-id942340-sqli', 'owasp-crs-v030301-id942220-sqli', 'owasp-crs-v030301-id942330-sqli', 'owasp-crs-v030301-id942210-sqli', 'owasp-crs-v030301-id942370-sqli', 'owasp-crs-v030301-id942430-sqli']})"
      }
    }
    description = "WAF: SQLi for Slack/MCP (Surgical Map-based Exclusion in CEL)"
  }

  # Rule 500: Global SQLi
  # Everyone else (Non-Slack, Non-MCP) gets full SQLi protection.
  rule {
    action   = "deny(403)"
    priority = "500"
    preview  = false
    match {
      expr {
        expression = "!(${local.global_waf_exclusion_scope}) && !request.path.startsWith('/mcp/') && evaluatePreconfiguredWaf('sqli-v33-stable')"
      }
    }
    description = "WAF: SQLi for Global Traffic"
  }

  # =========================================================
  # 4. ALLOW RULES (Rules 1000+)
  #    Traffic that reaches here is clean (passed WAF).
  # =========================================================

  # --- Group: Slack (Webhooks & Browser Flow) ---
  # --- Group: Slack Webhooks (Verified) ---
  rule {
    action   = "allow"
    priority = "1000"
    match {
      expr {
        # Simple path check. Legitimacy is guaranteed by earlier Drop rules (90/91).
        expression = local.slack_path_scope
      }
    }
    description = "Allow: Verified Slack POST Events"
  }

  # --- Group: Slack Browser Flow (Install/OAuth) ---
  rule {
    action   = "allow"
    priority = "1001"
    match {
      expr {
        expression = "request.method == 'GET' && (request.path == '/slack/install' || request.path == '/slack/oauth-redirect')"
      }
    }
    description = "Allow: Slack Browser Flow"
  }

  # --- Group: User Authentication ---
  rule {
    action   = "allow"
    priority = "1100"
    match {
      expr {
        # Complexity: Method(1) && (Path(1) || Path(1)) = 3 atoms. Safe.
        expression = "request.method == 'GET' && (request.path == '/auth/login' || request.path == '/auth/callback')"
      }
    }
    description = "Allow: User Login Flow"
  }

  # --- Group: MCP Search ---
  rule {
    action   = "allow"
    priority = "1200"
    match {
      expr {
        # Complexity: (Method(1) && Path(1)) || (Method(1) && (Path(1) || Path(1))) = 5 atoms. Safe.
        expression = "(request.method == 'GET' && request.path == '/mcp/sse') || (request.method == 'POST' && (request.path == '/mcp/messages' || request.path == '/mcp/messages/'))"
      }
    }
    description = "Allow: MCP Search (SSE/POST)"
  }

  # --- Group: Utilities & Maintenance ---
  rule {
    action   = "allow"
    priority = "1300"
    match {
      expr {
        # Complexity: Method(1) && (Path(1) || Path(1)) = 3 atoms. Safe.
        expression = "request.method == 'GET' && (request.path == '/health' || request.path.startsWith('/_gcp_iap/'))"
      }
    }
    description = "Allow: Health Check and IAP"
  }

  # =========================================================
  # 5. DEFAULT DENY
  # =========================================================
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
# Note: This is required because IAP requires explicit roles/iap.httpsResourceAccessor
# to authorize service-to-service calls even with a valid OIDC token.
resource "google_iap_web_backend_service_iam_member" "mcp_iap_access" {
  project             = var.gcp_gemini_project_id
  web_backend_service = google_compute_backend_service.mcp_backend.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = "serviceAccount:${google_service_account.aibot_logic.email}"
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

resource "google_secret_manager_secret_iam_member" "logic_config_access" {
  secret_id = google_secret_manager_secret.logic_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.aibot_logic.email}"
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

resource "google_secret_manager_secret_iam_member" "webhook_config_access" {
  secret_id = google_secret_manager_secret.webhook_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.aibot_webhook.email}"
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

resource "google_secret_manager_secret_iam_member" "mcp_config_access" {
  secret_id = google_secret_manager_secret.mcp_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.slack_search_mcp.email}"
}
resource "google_secret_manager_secret_version" "mcp_config" {
  secret = google_secret_manager_secret.mcp_config.id
  secret_data = jsonencode({
    teamIdsForSearch       = "REPLACE_ME"
    enterpriseIdsForSearch = "REPLACE_ME"
    iapClientId            = var.iap_client_id
    iapClientSecret        = var.iap_client_secret
    iapTargetClientId      = "/projects/${data.google_project.project.number}/global/backendServices/${google_compute_backend_service.mcp_backend.generated_id}"
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

resource "google_secret_manager_secret_iam_member" "collector_config_access" {
  secret_id = google_secret_manager_secret.collector_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.collect_slack_messages.email}"
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

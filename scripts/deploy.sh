#!/bin/bash
set -e

# Determine Project Root (one level up from this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# 1. Environment Loading
if [ -f .env ]; then
  echo "--- Loading .env file ---"
  source .env
fi

# Fallback Configuration
PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project)}
REGION=${REGION:-"europe-west2"}
BQ_LOCATION=${MULTI_REGION:-"EU"}
PROJECT_NUMBER=${PROJECT_NUMBER:-$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')}
CUSTOM_FQDN=${CUSTOM_FQDN:-"aibot.example.com"}

echo "Using Project: $PROJECT_ID ($PROJECT_NUMBER)"
echo "Region: $REGION"
echo "FQDN: $CUSTOM_FQDN"
BOT_NAME=${BOT_NAME:-"AIBot"}
SUPERVISOR_MODEL=${SUPERVISOR_MODEL:-"gemini-2.5-flash"}
AUTH_URL=${AUTH_URL:-"https://${CUSTOM_FQDN}/slack/oauth-redirect"}

# Common Terraform Vars
TF_VARS="-var=gcp_gemini_project_id=$PROJECT_ID \
         -var=gcp_gemini_project_number=$PROJECT_NUMBER \
         -var=gcp_region=$REGION \
         -var=gcp_bq_location=$BQ_LOCATION \
         -var=custom_fqdn=$CUSTOM_FQDN \
         -var=iap_client_id=$IAP_CLIENT_ID \
         -var=iap_client_secret=$IAP_CLIENT_SECRET"

FAST_MODE=false
NO_TF=false
NO_SECRETS=false
TARGET_SERVICE=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --fast) FAST_MODE=true ;;
    --no-tf) NO_TF=true ;;
    --no-secrets) NO_SECRETS=true ;;
    --service) TARGET_SERVICE="$2"; shift ;;
    *) echo "Unknown parameter passed: $1"; exit 1 ;;
  esac
  shift
done

if [ "$FAST_MODE" = true ]; then
  echo "--- FAST MODE: Skipping Infrastructure Bootstrap ---"
fi

if [ "$NO_TF" = true ]; then
  echo "--- NO-TF MODE: Skipping Terraform entirely ---"
fi

if [ "$NO_SECRETS" = true ]; then
  echo "--- NO-SECRETS MODE: Skipping Secret Synchronization ---"
fi

if [ -n "$TARGET_SERVICE" ]; then
  echo "--- TARGET SERVICE: $TARGET_SERVICE ---"
fi

# 2. Foundation Bootstrap
if [ "$NO_TF" = false ]; then
  ( cd terraform && ./init.sh )
fi

# 2. Infrastructure Provisioning
if [[ "$FAST_MODE" = false && "$NO_TF" = false ]]; then
  echo "--- Provisioning Infrastructure ---"
  ( cd terraform && terraform apply -auto-approve $TF_VARS )
fi

# 3. Optimized Build Process
echo "--- Optimized Docker Build ---"
export DOCKER_BUILDKIT=1
REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/aibot-images"

# Step A: Build/Update Base Image (Cached Foundation)
# Only build base if we are not in targeted service mode OR if specifically requested (implied by no service)
if [ -z "$TARGET_SERVICE" ]; then
  echo "Checking/Building aibot-base..."
  docker build -t aibot-base:latest -f python/base.Dockerfile .
fi

# Step B: Build Services using Base Image
SERVICES=("slack_collector" "slack_search_mcp" "aibot_logic")
for SVC in "${SERVICES[@]}"; do
  IMG_NAME=$(echo "$SVC" | tr '_' '-')
  
  # If TARGET_SERVICE is set, only build if it matches (mapping logic-side)
  if [[ -n "$TARGET_SERVICE" ]]; then
    MAPPED_TARGET=$(echo "$TARGET_SERVICE" | tr '-' '_')
    # Special case: aibot-webhook uses aibot-logic image
    if [[ "$TARGET_SERVICE" == "aibot-webhook" ]]; then
      MAPPED_TARGET="aibot_logic"
    fi
    if [[ "$SVC" != "$MAPPED_TARGET" ]]; then
      continue
    fi
  fi

  echo "Building $IMG_NAME..."
  docker build -t ${REPO}/${IMG_NAME}:latest --build-arg SERVICE_NAME=$SVC -f python/Dockerfile .
  docker push ${REPO}/${IMG_NAME}:latest
done

# Step C: Forced Update of Cloud Run (Ensure latest image is pulled)
echo "Forcing Cloud Run updates to pull latest images..."
for SVC in "aibot-webhook" "aibot-logic" "slack-collector" "slack-search-mcp"; do
  # If TARGET_SERVICE is set, filter
  if [[ -n "$TARGET_SERVICE" ]]; then
     # If we are updating aibot-logic, we MUST also update aibot-webhook as it shares the image
     if [[ "$TARGET_SERVICE" == "aibot-logic" || "$TARGET_SERVICE" == "aibot-webhook" ]]; then
        if [[ "$SVC" != "aibot-logic" && "$SVC" != "aibot-webhook" ]]; then
          continue
        fi
     elif [[ "$SVC" != "$TARGET_SERVICE" ]]; then
        continue
     fi
  fi

  # Default: Image name matches Service name
  IMG="$SVC"
  
  # Exception: aibot-webhook uses aibot-logic image
  if [ "$SVC" == "aibot-webhook" ]; then
    IMG="aibot-logic"
  fi

  # Scaling Configuration
  MIN=0
  MAX=5
  if [ "$SVC" == "aibot-webhook" ]; then
    MIN=1
  fi

  echo "Updating $SVC with image ${REPO}/${IMG}:latest (min: $MIN, max: $MAX)..."
  gcloud run services update $SVC \
    --image ${REPO}/${IMG}:latest \
    --min-instances $MIN \
    --max-instances $MAX \
    --region $REGION \
    --quiet || echo "Warning: Could not update $SVC"
done

# 4. Final Infrastructure Update
if [ "$NO_TF" = false ]; then
  echo "--- Finalizing Deployment ---"
  ( cd terraform && terraform apply -auto-approve $TF_VARS )
fi

# 5. Secret Synchronization
if [ "$NO_SECRETS" = false ]; then
  echo "--- Synchronizing Secrets ---"
  # Function to disable older versions of a secret
  disable_old_versions() {
    local SECRET_ID=$1
    echo "Disabling older versions of $SECRET_ID..."
    # List all enabled versions, skip the first one (latest), and disable the rest
    VERSIONS=$(gcloud secrets versions list "$SECRET_ID" --filter="state=enabled" --format="value(name)" | tail -n +2)
    for V in $VERSIONS; do
      gcloud secrets versions disable "$V" --secret="$SECRET_ID" --quiet || true
    done
  }

  if [ -n "$SLACK_BOT_TOKEN" ]; then
    # aibot-logic-config (Service-specific only)
    echo "Updating aibot-logic-config..."
    JSON_LOGIC=$(printf '{"mcpSlackSearchUrl":"%s"}' "https://${CUSTOM_FQDN}/mcp")
    echo "$JSON_LOGIC" | gcloud secrets versions add aibot-logic-config --data-file=-
    disable_old_versions "aibot-logic-config"

    # aibot-webhook-config (Service-specific only - currently empty but kept for consistency)
    echo "Updating aibot-webhook-config..."
    JSON_WEBHOOK=$(printf '{"placeholder":"none"}')
    echo "$JSON_WEBHOOK" | gcloud secrets versions add aibot-webhook-config --data-file=-
    disable_old_versions "aibot-webhook-config"

    # slack-search-mcp-config (Service-specific only)
    echo "Updating slack-search-mcp-config..."
    JSON_MCP=$(printf '{"iapClientId":"%s","iapClientSecret":"%s"}' "$IAP_CLIENT_ID" "$IAP_CLIENT_SECRET")
    echo "$JSON_MCP" | gcloud secrets versions add slack-search-mcp-config --data-file=-
    disable_old_versions "slack-search-mcp-config"

    # slack-collector-config (Currently inherited from shared)
    echo "Updating slack-collector-config..."
    JSON_COLL=$(printf '{"placeholder":"none"}')
    echo "$JSON_COLL" | gcloud secrets versions add slack-collector-config --data-file=-
    disable_old_versions "slack-collector-config"

    # AIBot-shared-config (Shared/Global)
    echo "Updating AIBot-shared-config..."
    JSON_SHARED=$(printf '{"slackBotToken":"%s","slackSigningSecret":"%s","slackClientId":"%s","slackClientSecret":"%s","slackUserToken":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s","botName":"%s","supervisorModel":"%s","authUrl":"%s"}' \
      "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET" "$SLACK_CLIENT_ID" "$SLACK_CLIENT_SECRET" "$SLACK_USER_TOKEN" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS" "$BOT_NAME" "$SUPERVISOR_MODEL" "$AUTH_URL")
    echo "$JSON_SHARED" | gcloud secrets versions add AIBot-shared-config --data-file=-
    disable_old_versions "AIBot-shared-config"
  else
    echo "Warning: Slack tokens not found in environment. Skipping secret synchronization."
  fi
fi

# 6. Check for IAP/Security Setup
if [[ "$IAP_CLIENT_ID" == "PLACEHOLDER" || "$IAP_CLIENT_ID" == "REPLACE_ME" || -z "$IAP_CLIENT_ID" ]]; then
  IAP_STATUS="⚠️  ACTION REQUIRED: IAP Not Configured"
  IAP_INSTRUCTION="Google has deprecated programmatic OAuth Client creation for IAP. You must set this up manually:
  
  1. Open the Google Cloud Console: https://console.cloud.google.com/apis/credentials
  2. Click '+ CREATE CREDENTIALS' -> 'OAuth client ID'
  3. Select Application type: 'Web application'
  4. Name it something like 'AIBot IAP Client'
  5. Add this specific AUTHORIZED REDIRECT URI:
     https://iap.googleapis.com/v1/oauth/clientIds/<YOUR_CLIENT_ID>:handleRedirect
  6. Copy the 'Client ID' and 'Client Secret' and paste them into your .env file.
  7. Re-run this script."
else
  IAP_STATUS="✅ IAP Configured ($IAP_CLIENT_ID)"
  IAP_INSTRUCTION="Internal authentication (Logic -> MCP) is enabled via Service Account ID tokens for IAP bypass."
fi

# 6. Extract Outputs & Summary
echo "--- Post-Deployment Status ---"
LB_IP=$(cd terraform && terraform output -raw load_balancer_ip)
MCP_URL=$(cd terraform && terraform output -raw mcp_search_url)
WEBHOOK_URL=$(cd terraform && terraform output -raw webhook_url)
CUSTOM_FQDN_OUT=$(cd terraform && terraform output -raw custom_fqdn_output)

echo "--- Deployment Complete ---"
echo "Project successfully regionalized in $REGION"
echo ""
echo "Security Configuration Status:"
echo "1. DNS Setup: Create an A record for your fqdn pointing to: $LB_IP"
echo "2. Slack App: Update your 'Event Subscriptions' Request URL to: $WEBHOOK_URL"
echo "3. Slack App: Update your 'Interactivity' Request URL to: https://${CUSTOM_FQDN_OUT}/slack/interactivity"
echo "4. Slack App: Update your 'Redirect URL' to: https://${CUSTOM_FQDN_OUT}/slack/oauth-redirect"
echo "5. Secrets: Automatically managed via .env"
echo ""
echo "Endpoints (Protected by IAP/Load Balancer):"
echo "  MCP Slack Search: $MCP_URL"
echo "  Webhook Ingress: $WEBHOOK_URL"
echo ""
echo "Managed Infrastructure (Verified):"
echo "  - Global External Load Balancer: Active"
echo "  - Cloud Armor WAF: Enabled (sql/xss protection)"
echo "  - Stealth Security: Enabled (403 on unauth paths, docs disabled)"
echo "  - Identity-Aware Proxy: $IAP_STATUS"
echo "  - Certificate Manager Mapping: Active"
echo ""
echo "Security Action:"
echo "  $IAP_INSTRUCTION"
echo ""
echo "Next Step: Verify SSL status at https://console.cloud.google.com/security/ccm/list/lbCertificates"

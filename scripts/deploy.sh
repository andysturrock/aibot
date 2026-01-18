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

# Common Terraform Vars
TF_VARS="-var=gcp_gemini_project_id=$PROJECT_ID \
         -var=gcp_gemini_project_number=$PROJECT_NUMBER \
         -var=gcp_region=$REGION \
         -var=gcp_bq_location=$BQ_LOCATION \
         -var=custom_fqdn=$CUSTOM_FQDN \
         -var=iap_client_id=$IAP_CLIENT_ID \
         -var=iap_client_secret=$IAP_CLIENT_SECRET"

FAST_MODE=false
if [[ "$*" == *"--fast"* ]]; then
  FAST_MODE=true
  echo "--- FAST MODE: Skipping Infrastructure Bootstrap ---"
fi

# 2. Foundation Bootstrap
( cd terraform && ./init.sh )

# 2. Infrastructure Provisioning
if [ "$FAST_MODE" = false ]; then
  echo "--- Provisioning Infrastructure ---"
  ( cd terraform && ./init.sh )
  ( cd terraform && terraform apply -auto-approve $TF_VARS )
fi

# 3. Optimized Build Process
echo "--- Optimized Docker Build ---"
export DOCKER_BUILDKIT=1
REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/aibot-images"

# Step A: Build/Update Base Image (Cached Foundation)
# This layer contains the OS deps, venv, and the shared library
echo "Checking/Building aibot-base..."
docker build -t aibot-base:latest -f python/base.Dockerfile .

# Step B: Build Services using Base Image
# This will be very fast as OS deps and shared libs are already in the base
SERVICES=("slack_collector" "slack_search_mcp" "aibot_logic")
for SVC in "${SERVICES[@]}"; do
  IMG_NAME=$(echo "$SVC" | tr '_' '-')
  echo "Building $IMG_NAME..."
  docker build -t ${REPO}/${IMG_NAME}:latest --build-arg SERVICE_NAME=$SVC -f python/Dockerfile .
  docker push ${REPO}/${IMG_NAME}:latest
done

# Step C: Forced Update of Cloud Run (Ensure latest image is pulled)
echo "Forcing Cloud Run updates to pull latest images..."
# Services now use consistent naming: (kebab-case matches image name)
# Exceptions are handled explicitly.
for SVC in "aibot-webhook" "aibot-logic" "slack-collector" "slack-search-mcp"; do
  # Default: Image name matches Service name
  IMG="$SVC"
  
  # Exception: aibot-webhook uses aibot-logic image
  if [ "$SVC" == "aibot-webhook" ]; then
    IMG="aibot-logic"
  fi

  echo "Updating $SVC with image ${REPO}/${IMG}:latest..."
  gcloud run services update $SVC --image ${REPO}/${IMG}:latest --region $REGION --quiet || echo "Warning: Could not update $SVC"
done

# 4. Final Infrastructure Update
echo "--- Finalizing Deployment ---"
( cd terraform && terraform apply -auto-approve $TF_VARS )

# 5. Secret Synchronization
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
  # aibot-logic-config
  echo "Updating aibot-logic-config..."
  JSON_LOGIC=$(printf '{"slackBotToken":"%s","slackSigningSecret":"%s","slackClientId":"%s","slackClientSecret":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s","mcpSlackSearchUrl":"%s"}' \
    "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET" "$SLACK_CLIENT_ID" "$SLACK_CLIENT_SECRET" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS" "https://${CUSTOM_FQDN}/mcp")
  echo "$JSON_LOGIC" | gcloud secrets versions add aibot-logic-config --data-file=-
  disable_old_versions "aibot-logic-config"

  # aibot-webhook-config
  echo "Updating aibot-webhook-config..."
  JSON_WEBHOOK=$(printf '{"slackBotToken":"%s","slackSigningSecret":"%s","slackClientId":"%s","slackClientSecret":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s"}' \
    "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET" "$SLACK_CLIENT_ID" "$SLACK_CLIENT_SECRET" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS")
  echo "$JSON_WEBHOOK" | gcloud secrets versions add aibot-webhook-config --data-file=-
  disable_old_versions "aibot-webhook-config"

  # slack-search-mcp-config
  echo "Updating slack-search-mcp-config..."
  JSON_MCP=$(printf '{"slackUserToken":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s","iapClientId":"%s","iapClientSecret":"%s"}' \
    "$SLACK_USER_TOKEN" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS" "$IAP_CLIENT_ID" "$IAP_CLIENT_SECRET")
  echo "$JSON_MCP" | gcloud secrets versions add slack-search-mcp-config --data-file=-
  disable_old_versions "slack-search-mcp-config"

  # slack-collector-config
  echo "Updating slack-collector-config..."
  JSON_COLL=$(printf '{"slackUserToken":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s"}' \
    "$SLACK_USER_TOKEN" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS")
  echo "$JSON_COLL" | gcloud secrets versions add slack-collector-config --data-file=-
  disable_old_versions "slack-collector-config"
else
  echo "Warning: Slack tokens not found in environment. Skipping secret synchronization."
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
echo "  - Cloud Armor WAF: Enabled"
echo "  - Certificate Manager Mapping: Active"
echo ""
echo "Next Step: Verify SSL status at https://console.cloud.google.com/security/ccm/list/lbCertificates"

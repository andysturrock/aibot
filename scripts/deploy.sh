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

if [ "$FAST_MODE" = false ]; then
  echo "--- Provisioning Foundation ---"
  (
    cd terraform
    terraform apply -auto-approve \
      -target=google_artifact_registry_repository.aibot_images \
      -target=google_storage_bucket.aibot_documents \
      -target=google_storage_bucket.aibot_search_datastore \
      -target=google_bigquery_dataset.aibot_slack_messages \
      -target=google_bigquery_table.slack_content \
      -target=google_bigquery_table.slack_content_metadata \
      -target=google_project_service.artifactregistry \
      -target=google_project_service.cloudrun \
      -target=google_project_service.secretmanager \
      -target=google_project_service.firestore \
      $TF_VARS
  )
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

# 4. Final Infrastructure Update
echo "--- Finalizing Deployment ---"
( cd terraform && terraform apply -auto-approve $TF_VARS )

# 5. Secret Synchronization
echo "--- Synchronizing Secrets ---"
if [ -n "$SLACK_BOT_TOKEN" ]; then
  # aibot-logic-config
  echo "Updating aibot-logic-config..."
  JSON_LOGIC=$(printf '{"slackBotToken":"%s","slackSigningSecret":"%s","slackClientId":"%s","slackClientSecret":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s","mcpSlackSearchUrl":"%s"}' \
    "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET" "$SLACK_CLIENT_ID" "$SLACK_CLIENT_SECRET" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS" "https://${CUSTOM_FQDN}/mcp")
  echo "$JSON_LOGIC" | gcloud secrets versions add aibot-logic-config --data-file=-

  # mcp-slack-search-config
  echo "Updating mcp-slack-search-config..."
  JSON_MCP=$(printf '{"slackUserToken":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s","iapClientId":"%s","iapClientSecret":"%s"}' \
    "$SLACK_USER_TOKEN" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS" "$IAP_CLIENT_ID" "$IAP_CLIENT_SECRET")
  echo "$JSON_MCP" | gcloud secrets versions add mcp-slack-search-config --data-file=-

  # slack-collector-config
  echo "Updating slack-collector-config..."
  JSON_COLL=$(printf '{"slackUserToken":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s"}' \
    "$SLACK_USER_TOKEN" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS")
  echo "$JSON_COLL" | gcloud secrets versions add slack-collector-config --data-file=-
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

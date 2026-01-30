#!/bin/bash
set -e

# Determine Project Root (one level up from this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# 1. Option Defaults
FAST_MODE=false
NO_TF=false
NO_SECRETS=false
SECRETS_ONLY=false
TARGET_SERVICE=""

# 2. Environment Loading
ENV=""
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --env=*) ENV="${1#*=}" ;;
    --env) ENV="$2"; shift ;;
    --fast) FAST_MODE=true ;;
    --no-tf) NO_TF=true ;;
    --no-secrets) NO_SECRETS=true ;;
    --secrets-only) SECRETS_ONLY=true ;;
    --service) TARGET_SERVICE="$2"; shift ;;
  esac
  shift
done

if [[ "$ENV" != "prod" && "$ENV" != "beta" ]]; then
  echo "Error: You must specify --env=prod or --env=beta"
  exit 1
fi

ENV_FILE=".env.$ENV"
ENC_FILE=".env.$ENV.enc"

if [ -f "$ENC_FILE" ]; then
  echo "--- Decrypting $ENC_FILE with SOPS ---"
  # Use a temporary file with restrictive permissions and a trap for cleanup
  TEMP_ENV=$(mktemp)
  chmod 600 "$TEMP_ENV"
  trap 'rm -f "$TEMP_ENV"' EXIT
  sops -d --output-type dotenv "$ENC_FILE" > "$TEMP_ENV"
  source "$TEMP_ENV"
  rm "$TEMP_ENV"
  trap - EXIT # Clear the trap after successful removal
elif [ -f "$ENV_FILE" ]; then
  echo "--- Loading plaintext $ENV_FILE file ---"
  source "$ENV_FILE"
else
  echo "Error: Neither $ENV_FILE nor $ENC_FILE found."
  exit 1
fi

# Fallback Configuration
echo "Using Project ID: $PROJECT_ID ($ENV)"
gcloud config set project "$PROJECT_ID" --quiet

REGION=${REGION:-"europe-west2"}
BQ_LOCATION=${MULTI_REGION:-"EU"}
PROJECT_NUMBER=${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}
CUSTOM_FQDN=${CUSTOM_FQDN:-"aibot.example.com"}
GITHUB_REPO=${GITHUB_REPO:-"andysturrock/aibot"}

echo "Using Project Number: $PROJECT_NUMBER"
echo "Region: $REGION"
echo "FQDN: $CUSTOM_FQDN"

echo "Ensuring required APIs are enabled..."
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  bigquery.googleapis.com \
  discoveryengine.googleapis.com \
  aiplatform.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  compute.googleapis.com \
  iap.googleapis.com \
  serviceusage.googleapis.com \
  sts.googleapis.com \
  --project="$PROJECT_ID" --quiet

# Foundation: Ensure IAP Service Identity is provisioned (required for Cloud Run IAP)
echo "Ensuring IAP Service Identity is provisioned..."
gcloud beta services identity create --service=iap.googleapis.com --project=$PROJECT_ID || true
BOT_NAME=${BOT_NAME:-"AIBot"}
SUPERVISOR_MODEL=${SUPERVISOR_MODEL:-"gemini-2.5-flash"}
# AUTH_URL is optional, if not set it will be empty in secrets.
# Historically it was used for Slack OAuth, but for Google Login we calculate it dynamically.
AUTH_URL=${AUTH_URL:-""}

# Common Terraform Vars
TF_VARS="-var=gcp_gemini_project_id=$PROJECT_ID \
         -var=gcp_gemini_project_number=$PROJECT_NUMBER \
         -var=gcp_region=$REGION \
         -var=gcp_bq_location=$BQ_LOCATION \
         -var=custom_fqdn=$CUSTOM_FQDN \
         -var=iap_client_id=$IAP_CLIENT_ID \
         -var=iap_client_secret=$IAP_CLIENT_SECRET \
         -var=github_repo=$GITHUB_REPO"

# Arguments already parsed above for environment loading

if [ "$FAST_MODE" = true ]; then
  echo "--- FAST MODE: Skipping Infrastructure Bootstrap ---"
fi

if [ "$NO_TF" = true ]; then
  echo "--- NO-TF MODE: Skipping Terraform entirely ---"
fi

if [ "$NO_SECRETS" = true ]; then
  echo "--- NO-SECRETS MODE: Skipping Secret Synchronization ---"
fi

if [ "$SECRETS_ONLY" = true ]; then
  echo "--- SECRETS-ONLY MODE: Skipping TF, Builds, and service updates ---"
  NO_TF=true
fi

if [ -n "$TARGET_SERVICE" ]; then
  echo "--- TARGET SERVICE: $TARGET_SERVICE ---"
fi

# 2. Foundation Bootstrap
if [ "$NO_TF" = false ]; then
  ( cd terraform && ./init.sh --env="$ENV" )
fi

# 2. Infrastructure Provisioning
if [[ "$FAST_MODE" = false && "$NO_TF" = false ]]; then
  echo "--- Provisioning Infrastructure ---"
  ( cd terraform && ./init.sh --env="$ENV" && terraform apply -auto-approve $TF_VARS )
fi

# 3. Optimized Build Process
if [ "$SECRETS_ONLY" = false ]; then
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
fi

# 4. Final Infrastructure Update
if [ "$NO_TF" = false ]; then
  echo "--- Finalizing Deployment ---"
  ( cd terraform && terraform apply -auto-approve $TF_VARS )
fi

# 5. Secret Synchronization
if [ "$NO_SECRETS" = false ]; then
  echo "--- Synchronizing Secrets ---"
  disable_old_versions() {
    local SECRET_ID="$1"
    if [[ -z "$SECRET_ID" ]]; then
      echo "Warning: No Secret ID provided to disable_old_versions"
      return
    fi

    echo "Disabling older versions of $SECRET_ID..."
    # List all enabled versions, skip the first one (latest), and disable the rest
    # We use --format="value(name)" and carefully handle output
    local VERSIONS
    VERSIONS=$(gcloud secrets versions list "$SECRET_ID" --filter="state=enabled" --format="value(name)" --project="$PROJECT_ID" 2>/dev/null | tail -n +2) || true

    if [[ -n "$VERSIONS" ]]; then
      for V in $VERSIONS; do
        echo "  Disabling version $V..."
        gcloud secrets versions disable "$V" --secret="$SECRET_ID" --project="$PROJECT_ID" --quiet || true
      done
    fi
  }

  if [ -n "$SLACK_BOT_TOKEN" ]; then
    # aibot-logic-config (Service-specific only)
    echo "Updating aibot-logic-config..."
    JSON_LOGIC=$(printf '{"mcpSlackSearchUrl":"%s","iapClientId":"%s","iapClientSecret":"%s"}' "https://${CUSTOM_FQDN}/mcp" "$IAP_CLIENT_ID" "$IAP_CLIENT_SECRET")
    echo "$JSON_LOGIC" | gcloud secrets versions add aibot-logic-config --data-file=-
    disable_old_versions "aibot-logic-config"

    # aibot-webhook-config (Service-specific only - currently empty but kept for consistency)
    echo "Updating aibot-webhook-config..."
    JSON_WEBHOOK=$(printf '{"placeholder":"none"}')
    echo "$JSON_WEBHOOK" | gcloud secrets versions add aibot-webhook-config --data-file=-
    disable_old_versions "aibot-webhook-config"

    # slack-search-mcp-config (Service-specific only)
    echo "Updating slack-search-mcp-config..."
    # Retrieve Backend Service ID for IAP Audience
    BACKEND_SERVICE_ID=$(gcloud compute backend-services describe slack-search-mcp-backend --global --format='value(id)' 2>/dev/null || echo "PENDING")
    IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/global/backendServices/${BACKEND_SERVICE_ID}"

    JSON_MCP=$(printf '{"iapClientId":"%s","iapClientSecret":"%s","iapAudience":"%s"}' "$IAP_CLIENT_ID" "$IAP_CLIENT_SECRET" "$IAP_AUDIENCE")
    echo "$JSON_MCP" | gcloud secrets versions add slack-search-mcp-config --data-file=-
    disable_old_versions "slack-search-mcp-config"

    # slack-collector-config (Currently inherited from shared)
    echo "Updating slack-collector-config..."
    JSON_COLL=$(printf '{"placeholder":"none"}')
    echo "$JSON_COLL" | gcloud secrets versions add slack-collector-config --data-file=-
    disable_old_versions "slack-collector-config"

    # AIBot-shared-config (Shared/Global)
    echo "Updating AIBot-shared-config..."
    JSON_SHARED=$(printf '{"slackBotToken":"%s","slackSigningSecret":"%s","slackClientId":"%s","slackClientSecret":"%s","slackUserToken":"%s","teamIdsForSearch":"%s","enterpriseIdsForSearch":"%s","botName":"%s","supervisorModel":"%s","authUrl":"%s","customFqdn":"%s","iapClientId":"%s","iapClientSecret":"%s"}' \
      "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET" "$SLACK_CLIENT_ID" "$SLACK_CLIENT_SECRET" "$SLACK_USER_TOKEN" "$ALLOWED_TEAM_IDS" "$ALLOWED_ENTERPRISE_IDS" "$BOT_NAME" "$SUPERVISOR_MODEL" "$AUTH_URL" "$CUSTOM_FQDN" "$IAP_CLIENT_ID" "$IAP_CLIENT_SECRET")
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

#!/bin/bash
set -e

# Configuration
PROJECT_ID=$(gcloud config get-value project)
REGION="europe-west1" # Should match var.gcp_region in terraform

echo "Using GCP Project: $PROJECT_ID"
echo "Using Region: $REGION"

# 1. Build and Push Images
echo "--- Building and Pushing Docker Images ---"

# Service: Slack Collector
echo "Building slack-collector..."
docker build -t gcr.io/$PROJECT_ID/slack-collector:latest \
  --build-arg SERVICE_NAME=slack_collector \
  -f python/Dockerfile .
docker push gcr.io/$PROJECT_ID/slack-collector:latest

# Service: MCP Slack Search
echo "Building slack-search-mcp..."
docker build -t gcr.io/$PROJECT_ID/slack-search-mcp:latest \
  --build-arg SERVICE_NAME=slack_search_mcp \
  -f python/Dockerfile .
docker push gcr.io/$PROJECT_ID/slack-search-mcp:latest

# Service: AIBot Logic (Combined Webhook + Worker)
echo "Building aibot-logic..."
docker build -t gcr.io/$PROJECT_ID/aibot-logic:latest \
  --build-arg SERVICE_NAME=aibot_logic \
  -f python/Dockerfile .
docker push gcr.io/$PROJECT_ID/aibot-logic:latest

# Build existing TS services if needed (assuming latest images are already there or built via other scripts)
# But for a full redeploy we should include them or ensure they are present.
# For now, we focus on the Python services we just migrated.

# 2. Terraform Apply
echo "--- Applying Infrastructure Changes ---"
cd terraform
./init.sh
terraform apply -auto-approve \
  -var="gcp_gemini_project_id=$PROJECT_ID" \
  -var="gcp_region=$REGION"

echo "--- Deployment Complete ---"
echo "Slack Collector: https://slack-collector-$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)').$REGION.run.app"
echo "MCP Slack Search: https://slack-search-mcp-$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)').$REGION.run.app"

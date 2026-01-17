#!/bin/bash

#
# Script to set up terraform workspace.
#

set -eo pipefail

# Look for .env in current or parent directory
if [ -f .env ]; then
  ENV_FILE=".env"
elif [ -f "../.env" ]; then
  ENV_FILE="../.env"
else
  echo ".env file not found in terraform or parent directory."
  exit 1
fi

echo "Loading env vars from $ENV_FILE"
source "$ENV_FILE"

# Provide fallbacks/defaults
PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project)}
REGION=${REGION:-"europe-west2"}
TF_STATE_BUCKET="${PROJECT_ID}-aibot-terraform-state"

# Check if the state bucket exists, create if not
if ! gsutil ls -b "gs://$TF_STATE_BUCKET" >/dev/null 2>&1; then
  echo "Bucket gs://$TF_STATE_BUCKET does not exist. Creating..."
  gsutil mb -p "$PROJECT_ID" -l "$REGION" "gs://$TF_STATE_BUCKET"
else
  echo "Bucket gs://$TF_STATE_BUCKET already exists."
fi

echo "Initializing Terraform with GCS backend..."
terraform init -upgrade \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="prefix=aibot/terraform/state" \
  -reconfigure

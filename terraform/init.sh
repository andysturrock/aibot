#!/bin/bash

#
# Script to set up terraform workspace.
#

set -eo pipefail

# 1. Environment Loading
ENV=""
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --env=*) ENV="${1#*=}" ;;
    --env) ENV="$2"; shift ;;
  esac
  shift
done

if [[ "$ENV" != "prod" && "$ENV" != "beta" ]]; then
  echo "Error: You must specify --env=prod or --env=beta"
  exit 1
fi

ENV_FILE=".env.$ENV"
# Check if symlink/file exists in current or parent
if [ -f "$ENV_FILE" ]; then
  FULL_ENV_PATH="$ENV_FILE"
elif [ -f "../$ENV_FILE" ]; then
  FULL_ENV_PATH="../$ENV_FILE"
else
  echo "Error: $ENV_FILE not found."
  exit 1
fi

echo "Loading env vars from $FULL_ENV_PATH"
source "$FULL_ENV_PATH"

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
gsutil versioning set on "gs://$TF_STATE_BUCKET"
gsutil lifecycle set gcs-lifecycle.json "gs://$TF_STATE_BUCKET"

echo "Initializing Terraform with GCS backend..."
terraform init -upgrade \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="prefix=aibot/terraform/state" \
  -reconfigure

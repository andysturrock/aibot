#!/bin/bash

#
# Script to set up terraform workspace.
#

set -eo pipefail

if [ ! -f .env ]; then
  echo ".env file not found in terraform directory."
  exit 1
fi

echo "Loading env vars from .env"
. ./.env

# Check if the state bucket exists, create if not
if ! gsutil ls -b "gs://$TF_STATE_BUCKET" >/dev/null 2>&1; then
  echo "Bucket gs://$TF_STATE_BUCKET does not exist. Creating..."
  gsutil mb -p "$PROJECT_ID" -l "$REGION" "gs://$TF_STATE_BUCKET"
else
  echo "Bucket gs://$TF_STATE_BUCKET already exists."
fi

echo "Initializing Terraform with GCS backend..."
terraform init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="prefix=terraform/state/$TF_ENV" \
  -reconfigure

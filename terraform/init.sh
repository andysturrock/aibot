#!/bin/bash

#
# Script to set up terraform workspace.
#

set -eo pipefail

# Get the directory where the script is located and change to it
# This ensures relative paths (like gcs-lifecycle.json) work correctly
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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
ENC_FILE=".env.$ENV.enc"

# Look for files in current or parent directory
if [ -f "$ENC_FILE" ]; then
    FULL_ENC_PATH="$ENC_FILE"
elif [ -f "../$ENC_FILE" ]; then
    FULL_ENC_PATH="../$ENC_FILE"
fi

if [ -f "$ENV_FILE" ]; then
    FULL_ENV_PATH="$ENV_FILE"
elif [ -f "../$ENV_FILE" ]; then
    FULL_ENV_PATH="../$ENV_FILE"
fi

if [ -n "$FULL_ENC_PATH" ]; then
    echo "Decrypting $FULL_ENC_PATH with SOPS..."
    TEMP_ENV=$(mktemp)
    chmod 600 "$TEMP_ENV"
    trap 'rm -f "$TEMP_ENV"' EXIT

    # Consistent decryption logic: handle possible JSON/raw format
    if sops -d "$FULL_ENC_PATH" | grep -q '"data":'; then
        sops -d --extract '["data"]' "$FULL_ENC_PATH" | python3 -c "import sys; content=sys.stdin.read().strip(); print(content[1:-1].replace('\\\\n', '\\n').replace('\\\\\"', '\"'))" > "$TEMP_ENV"
    else
        sops -d "$FULL_ENC_PATH" > "$TEMP_ENV"
    fi

    source "$TEMP_ENV"
    rm "$TEMP_ENV"
    trap - EXIT
elif [ -n "$FULL_ENV_PATH" ]; then
    echo "Loading plaintext $FULL_ENV_PATH"
    source "$FULL_ENV_PATH"
else
    echo "Error: Neither $ENV_FILE nor $ENC_FILE found."
    exit 1
fi

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

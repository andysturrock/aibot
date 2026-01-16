#!/bin/bash

#
# Script to set up workspace so can have multiple environments.
#

set -eo pipefail

echo "Loading env vars from .env"
. ./.env

echo "Creating ./cloud.tf from manifests/cloud.tf..."
# Note use | as the separator in sed command rather than the usual /
# This is in case any of the replacement values have / in them.
sed -e "s|__TF_ORG__|$TF_ORG|g" \
-e "s|__TF_PROJECT__|$TF_PROJECT|g" \
-e "s|__TF_STATE_BUCKET__|$TF_STATE_BUCKET|g" \
-e "s|__TF_ENV__|$TF_ENV|g" \
../manifests/cloud.tf > ./cloud.tf

# Check if the state bucket exists, create if not
if ! gsutil ls -b "gs://$TF_STATE_BUCKET" >/dev/null 2>&1; then
  echo "Bucket gs://$TF_STATE_BUCKET does not exist. Creating..."
  gsutil mb -p "$PROJECT_ID" -l "$REGION" "gs://$TF_STATE_BUCKET"
else
  echo "Bucket gs://$TF_STATE_BUCKET already exists."
fi

terraform init

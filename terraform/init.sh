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
-e "s|__TF_ENV__|$TF_ENV|g" \
../manifests/cloud.tf > ./cloud.tf

terraform init

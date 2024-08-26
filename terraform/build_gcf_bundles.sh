#!/bin/bash

set -eo pipefail

echo "Deleting old bundles..."
rm -rf ./dist

mkdir -p ./dist

cloud_functions=" \
  handle_collect_slack_messages \
"
module_files=" \
gcp_api.py
slack_api.py
"
for cloud_function in ${cloud_functions}
do
  echo "Bundling ${cloud_function}..."
  ( cd ../gcp-cf-src && \
    zip ../terraform/dist/${cloud_function}.zip ${cloud_function}.py main.py requirements.txt ${module_files}
    # zip ../terraform/dist/${cloud_function}.zip main.py requirements.txt
    # zip ../terraform/dist/${cloud_function}.zip ${cloud_function}.py
  )
  # echo "Copying $cloud_function}.zip to GCS..."
  # ( cd ../gcp-cf-src && \
  #   gsutil cp dist/${cloud_function}.zip
  # )
  
done
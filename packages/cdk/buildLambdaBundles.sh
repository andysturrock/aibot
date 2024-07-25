#!/bin/bash

set -eo pipefail

echo "Deleting old bundles..."
rm -rf ../lambda-src/dist

echo "Typechecking files..."
( cd ../lambda-src &&
 tsc --noEmit --project ./tsconfig-build.json
)

lambdas=" \
  handlePromptCommand \
  handleSlackAuthRedirect \
  handleInteractiveEndpoint \
  handleEventsEndpoint \
  handleHomeTabEvent \
"

for lambda in ${lambdas}
do
  echo "Bundling ${lambda}..."
  # The enclosing in () means "execute in subshell", so this script doesn't change directory itself
  ( cd ../lambda-src && \
    esbuild ./ts-src/${lambda}.ts \
    --bundle \
    --external:aws-sdk \
    --sourcemap \
    --tsconfig=./tsconfig-build.json \
    --platform=node \
    --target=node18 \
    --tree-shaking=true \
    --minify \
    --outdir=./dist/${lambda}
  )
done

echo "Adding clientLibraryConfig-aws-aibot.json to handlePromptCommand bundle..."
cp ../lambda-src/clientLibraryConfig-aws-aibot.json ../lambda-src/dist/handlePromptCommand

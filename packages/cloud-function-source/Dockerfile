FROM node:22-slim AS builder

WORKDIR /app

# Copy root configurations
COPY package.json package-lock.json ./
COPY tsconfig.json ./

# Copy the cloud-function-source package
COPY packages/cloud-function-source/package.json ./packages/cloud-function-source/
COPY packages/cloud-function-source/tsconfig.json ./packages/cloud-function-source/
COPY packages/cloud-function-source/ts-src ./packages/cloud-function-source/ts-src

# Install dependencies for the workspace
RUN npm install

# Build the package
RUN npm run build --workspace=packages/cloud-function-source

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/packages/cloud-function-source/package.json ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/cloud-function-source/dist ./dist

EXPOSE 8080

CMD ["node", "dist/gcp-entrypoint.js"]

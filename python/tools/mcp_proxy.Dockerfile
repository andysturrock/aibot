FROM python:3.13-slim

# Install OS dependencies for gcloud
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl \
  ca-certificates \
  gnupg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] http://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list \
  && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && apt-get update && apt-get install -y google-cloud-cli \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create a non-root user for security
RUN groupadd -g 9999 mcp && useradd -m -u 9999 -g 9999 mcp
USER mcp
WORKDIR /home/mcp

# Install Python dependencies
RUN pip install --no-cache-dir \
  mcp \
  httpx \
  aiohttp \
  google-auth \
  requests \
  python-dotenv \
  keyring

# Copy the proxy script
COPY --chown=mcp:mcp python/tools/mcp_proxy.py /home/mcp/mcp_proxy.py

# Entrypoint
ENTRYPOINT ["python3", "-u", "/home/mcp/mcp_proxy.py"]

# MCP Bridge for IAP-Protected Servers

This bridge enables Antigravity to connect to Model Context Protocol (MCP) servers that are protected by Google Cloud Identity-Aware Proxy (IAP).

## Overview
The bridge runs as a local MCP server (using `stdio`) and proxies requests to a remote MCP server (using `sse`). It handles IAP authentication by acquiring an identity token using your local `gcloud` credentials.

## Prerequisites
- **Python 3.10+**
- **Google Cloud SDK (`gcloud`)** installed and authenticated (`gcloud auth login`).
- **GCP Secret Manager** access (if using automated secret retrieval).

## Installation

1. **Clone the repository** (if not already done).
2. **Install dependencies**:
   ```bash
   pip install mcp httpx aiohttp google-auth google-oauth2-id-token python-dotenv
   ```
3. **Configure Permissions**:
   Ensure your local identity has the `Secret Manager Secret Accessor` role for the secrets used by the bridge.

## Configuring Antigravity

Add the bridge to your Antigravity configuration via the agent's "**...**" menu -> "**Manage MCP Servers**" -> "**View raw config**".

### Configuration Template

Replace the placeholders (`<...>`) with your specific details:

```json
{
  "mcpServers": {
    "slack-search": {
      "command": "/path/to/python3",
      "args": [
        "-u",
        "/path/to/mcp_proxy.py",
        "--url", "<REMOTE_MCP_SSE_URL>",
        "--project", "<GCP_PROJECT_ID>",
        "--audience", "<IAP_AUDIENCE_OR_BACKEND_NAME>",
        "--secret-name", "<SECRET_NAME_IN_SECRET_MANAGER>",
        "--skip-alignment"
      ],
      "env": {
        "HOME": "/home/username"
      }
    }
  }
}
```

### Arguments Detail
- `--url`: The SSE endpoint of the remote MCP server.
- `--project`: Your GCP Project ID.
- `--audience`: The IAP audience (e.g., `/projects/<PROJECT_NUM>/global/backendServices/<BACKEND_ID>`) or the name of the backend service to discover it.
- `--secret-name`: (Optional) The name of a secret in Secret Manager containing `iapClientId` and `iapClientSecret`.
- `--skip-alignment`: Recommended for standard IAP setups.

## Authentication Flow
1. **Fast Path**: The bridge checks `~/.config/gcloud/mcp_bridge_tokens.json` for a valid cached token.
2. **Refresh**: If the token is expired, it uses the cached `refresh_token` to get a new one.
3. **Browser Fallback**: If no tokens are cached, it opens a browser window for a standard Google OAuth flow to grant access.

## Troubleshooting
- **EOF Errors**: Ensure logging levels in `mcp_proxy.py` are set to `WARNING` or higher for stdout stability, or redirect `stderr` to a file.
- **Permission Denied**: Run `gcloud auth login` and ensure the project and secret names are correct.

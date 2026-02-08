# MCP Bridge Setup (Native Python)

The MCP bridge allows Antigravity (or any other MCP-compatible client) to securely communicate with IAP-protected services in Google Cloud. This native implementation runs directly on your host machine, avoiding the overhead and complexity of Docker.

## Prerequisites
- **Python 3.10+**
- **[uv](https://docs.astral.sh/uv/)** (Python package manager)
- **Google Cloud SDK (`gcloud`)** installed and authenticated (`gcloud auth login`).

### Install Dependencies
From the repository root, install all workspace dependencies:
```bash
uv sync --dev
```

## Setup & Configuration

### 1. Connection Details
To configure the bridge, you need several values from your GCP project. These are typically managed via your `.env.beta` or `.env.prod` files:
- **IAP_URL**: The endpoint of your remote MCP server (e.g., `https://aibot.example.com/mcp/sse`).
- **Project ID**: Your GCP Project ID.
- **Backend Name**: The name of the backend service (e.g., `slack-search-mcp`).

> [!NOTE]
> The bridge is smart! If you specify `--env beta`, it will automatically look for `IAP_URL` in your `.env.beta` file. If that's missing, it will even try to construct it using your `CUSTOM_FQDN`.

### 2. Secret Manager Configuration
By default, the bridge fetches its OAuth Client ID and Secret from **Secret Manager**. Ensure your account has the `Secret Manager Secret Accessor` role on the secret (default name: `slack-search-mcp-config`).

> [!TIP]
> **No Secret Manager Access?** If you cannot access Secret Manager, you can manually provide the credentials in your `mcp_config.json` using the `--client-id` and `--client-secret` arguments. Ask an administrator for these values. They should look like this:
> - **Client ID**: `123456789012-abc123def456.apps.googleusercontent.com`
> - **Client Secret**: `GOCSPX-abc123def456ghi789jkl012mno`

### 3. mcp_config.json
Add the bridge to your MCP configuration file.

#### Standard Setup (Using Secret Manager)
```json
{
  "mcpServers": {
    "slack-search-mcp-server": {
      "command": "uv",
      "args": [
        "run", "--dev", "--project", "<PATH_TO_AIBOT_REPO>",
        "python", "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
        "--backend", "slack-search-mcp",
        "--project", "<YOUR_PROJECT_ID>"
      ]
    }
  }
}
```

#### Alternative Setup (Manual Overrides)
Use this if you don't have Secret Manager access.
```json
{
  "mcpServers": {
    "slack-search-mcp-server": {
      "command": "uv",
      "args": [
        "run", "--dev", "--project", "<PATH_TO_AIBOT_REPO>",
        "python", "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
        "--backend", "slack-search-mcp",
        "--project", "<YOUR_PROJECT_ID>",
        "--client-id", "123456789012-abc123def456.apps.googleusercontent.com",
        "--client-secret", "GOCSPX-abc123def456ghi789jkl012mno"
      ]
    }
  }
}
```

> [!IMPORTANT]
> The proxy must be launched via `uv run` rather than bare `python3`, so that all workspace dependencies (`httpx`, `mcp`, `keyring`, etc.) are available. Using `python3` directly will fail with `ModuleNotFoundError`.

## Security & Authentication

### Identity-Aware Proxy (IAP)
The bridge performs OIDC authentication. It prioritizes the following order:
1.  **OS Keyring**: Securely stores and retrieves tokens.
2.  **Local File Cache**: Fallback storage (`~/.cache/mcp-proxy/`) if the keyring is unavailable.
3.  **Interactive Browser Flow**: If tokens are missing or expired, the bridge will automatically open your default browser for a "one-click" login.

### IP Alignment Security Check
By default, the bridge verifies that the target URL resolves to an IP address owned by your GCP project. This prevents sending your identity token to an untrusted or malicious endpoint.

> [!TIP]
> **Troubleshooting**: If you are in a complex network environment (like some WSL setups) and encounter IP resolution errors, you can add `--skip-alignment` to the `args` in your `mcp_config.json`.

## Maintenance
- **Keyring Issues**: If you see warnings about missing keyring backends, ensure you have a standard secret service running (like `gnome-keyring` on Linux) or rely on the automatic file cache fallback.
- **Token Expiry**: The bridge handles token refreshing automatically. If you are prompted to log in again, simply follow the browser flow.

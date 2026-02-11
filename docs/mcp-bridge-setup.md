# MCP Bridge Setup (Native Python)

The MCP bridge allows MCP-compatible clients (Claude Code, Gemini CLI, Antigravity, etc.) to securely communicate with IAP-protected services in Google Cloud. This native implementation runs directly on your host machine, avoiding the overhead and complexity of Docker.

## Prerequisites
- **Python 3.10+**
- **pip** (Python package manager)
- **Google Cloud SDK (`gcloud`)** installed and authenticated (`gcloud auth login`).

### Install Dependencies
Run the following command on your host machine:
```bash
pip install keyring httpx aiohttp mcp python-dotenv
```

## Setup & Configuration

### 1. Connection Details
To configure the bridge, you need several values from your GCP project. These are typically managed via your `.env.beta` or `.env.prod` files:
- **IAP_URL**: The endpoint of your remote MCP server (e.g., `https://aibot.example.com/mcp/sse`).
- **Project ID**: Your GCP Project ID.
- **Backend Name**: The name of the backend service (e.g., `slack-search-mcp`).

> [!NOTE]
> The bridge is smart! If you specify `--env beta`, it will automatically look for `IAP_URL` in your `.env.beta` file. If that's missing, it will even try to construct it using your `CUSTOM_FQDN`.

### 2. Authentication Method

There are two ways to authenticate the bridge. **Service Account JWT** is recommended.

#### Recommended: Service Account JWT (no secrets needed)

This method uses a dedicated GCP Service Account and your existing `gcloud` credentials. No OAuth client_id or client_secret is needed on your machine.

**Prerequisites:**
1. Run `gcloud auth login` (authenticates your user identity)
2. Run `gcloud auth application-default login` (provides Application Default Credentials)
3. Your email must be in the organisation's allowed domain
4. The `mcp-client-accessor` service account must be provisioned (done via Terraform)

**How it works:**
1. The bridge uses your ADC to call the IAM Credentials `signJwt` API on the `mcp-client-accessor` service account
2. A signed JWT is sent to IAP as the bearer token
3. Your user identity token (from `gcloud auth print-identity-token`) is sent as `X-User-ID-Token` to identify you
4. IAP validates the JWT and the backend verifies your identity against the Slack workspace

#### Legacy: OAuth Client Credentials

This method requires the IAP OAuth Client ID and Secret, obtained either from Secret Manager or passed directly.

By default, the bridge fetches its OAuth Client ID and Secret from **Secret Manager**. Ensure your account has the `Secret Manager Secret Accessor` role on the secret (default name: `slack-search-mcp-config`).

> [!TIP]
> **No Secret Manager Access?** If you cannot access Secret Manager, you can manually provide the credentials in your `mcp_config.json` using the `--client-id` and `--client-secret` arguments. Ask an administrator for these values.

### 3. Client Configuration

Each MCP client stores its configuration in a different location. Below are the config file paths and the recommended Service Account JWT setup for each client.

Replace the placeholders:
- `<PATH_TO_AIBOT_REPO>` — absolute path to the aibot repository clone
- `<CUSTOM_FQDN>` — your deployment's FQDN (e.g. `aibot.dev.slackapps.example.com`)
- `<YOUR_PROJECT_ID>` — your GCP project ID
- `<YOUR_HOME_DIR>` — your home directory (e.g. `/home/username`)

#### Claude Code

**Config file:** `~/.claude.json`

Add the `mcpServers` key at the top level of the file (merge with any existing config):
```json
{
  "mcpServers": {
    "slack-search-mcp-server": {
      "command": "python3",
      "args": [
        "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
        "--url", "https://<CUSTOM_FQDN>/mcp/sse",
        "--project", "<YOUR_PROJECT_ID>",
        "--service-account", "mcp-client-accessor@<YOUR_PROJECT_ID>.iam.gserviceaccount.com",
        "--skip-alignment"
      ],
      "env": {
        "HOME": "<YOUR_HOME_DIR>"
      }
    }
  }
}
```

#### Gemini CLI

**Config file:** `~/.gemini/settings.json`

Add the `mcpServers` key:
```json
{
  "mcpServers": {
    "slack-search-mcp-server": {
      "command": "python3",
      "args": [
        "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
        "--url", "https://<CUSTOM_FQDN>/mcp/sse",
        "--project", "<YOUR_PROJECT_ID>",
        "--service-account", "mcp-client-accessor@<YOUR_PROJECT_ID>.iam.gserviceaccount.com",
        "--skip-alignment"
      ],
      "env": {
        "HOME": "<YOUR_HOME_DIR>"
      }
    }
  }
}
```

#### Antigravity (Windsurf)

**Config file:** `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "slack-search-mcp-server": {
      "command": "python3",
      "args": [
        "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
        "--url", "https://<CUSTOM_FQDN>/mcp/sse",
        "--project", "<YOUR_PROJECT_ID>",
        "--service-account", "mcp-client-accessor@<YOUR_PROJECT_ID>.iam.gserviceaccount.com",
        "--skip-alignment"
      ],
      "env": {
        "HOME": "<YOUR_HOME_DIR>"
      }
    }
  }
}
```

#### VSCode

**Config file:** `~/.config/Code/User/mcp.json` (Linux) or `~/Library/Application Support/Code/User/mcp.json` (macOS)

```json
{
  "mcpServers": {
    "slack-search-mcp-server": {
      "command": "python3",
      "args": [
        "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
        "--url", "https://<CUSTOM_FQDN>/mcp/sse",
        "--project", "<YOUR_PROJECT_ID>",
        "--service-account", "mcp-client-accessor@<YOUR_PROJECT_ID>.iam.gserviceaccount.com",
        "--skip-alignment"
      ],
      "env": {
        "HOME": "<YOUR_HOME_DIR>"
      }
    }
  }
}
```

#### Legacy Setup (any client)

If you need to use the older OAuth flow instead, replace the `args` array with:
```json
"args": [
  "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
  "--backend", "slack-search-mcp",
  "--project", "<YOUR_PROJECT_ID>"
]
```

Or with manual credential overrides (if you don't have Secret Manager access):
```json
"args": [
  "<PATH_TO_AIBOT_REPO>/python/tools/mcp_proxy.py",
  "--backend", "slack-search-mcp",
  "--project", "<YOUR_PROJECT_ID>",
  "--client-id", "123456789012-abc123def456.apps.googleusercontent.com",
  "--client-secret", "GOCSPX-abc123def456ghi789jkl012mno"
]
```

## Security & Authentication

### Identity-Aware Proxy (IAP)

**Service Account JWT path:** The bridge signs a JWT using the `mcp-client-accessor` service account via the IAM Credentials API. No OAuth secrets are stored locally. Your user identity is conveyed separately via an `X-User-ID-Token` header, verified by the backend.

**Legacy OAuth path:** The bridge performs OIDC authentication. It prioritizes the following order:
1.  **OS Keyring**: Securely stores and retrieves tokens.
2.  **Local File Cache**: Fallback storage (`~/.cache/mcp-proxy/`) if the keyring is unavailable.
3.  **Interactive Browser Flow**: If tokens are missing or expired, the bridge will automatically open your default browser for a "one-click" login.

### IP Alignment Security Check
By default, the bridge verifies that the target URL resolves to an IP address owned by your GCP project. This prevents sending your identity token to an untrusted or malicious endpoint.

> [!TIP]
> **Troubleshooting**: If you are in a complex network environment (like some WSL setups) and encounter IP resolution errors, you can add `--skip-alignment` to the `args` in your `mcp_config.json`.

### Error Handling
If authentication fails, the bridge starts a minimal MCP server that reports the error to your MCP client instead of crashing silently. You will see a tool called `authentication_error` with a description explaining what went wrong and how to fix it.

## Arguments Reference

| Argument | Description |
|----------|-------------|
| `--url` | SSE URL of the remote MCP server |
| `--env` | Environment preset (`beta` or `prod`) |
| `--project` | GCP Project ID |
| `--backend` | Backend service name (default: `slack-search-mcp`) |
| `--audience` | Explicit IAP audience |
| `--service-account` | Service account email for JWT-based IAP auth (recommended) |
| `--secret-name` | Secret Manager name (default: `slack-search-mcp-config`) |
| `--client-id` | Override OAuth Client ID (legacy) |
| `--client-secret` | Override OAuth Client Secret (legacy) |
| `--skip-alignment` | Skip IP alignment security check |

## Maintenance
- **Keyring Issues**: If you see warnings about missing keyring backends, ensure you have a standard secret service running (like `gnome-keyring` on Linux) or rely on the automatic file cache fallback.
- **Token Expiry**: The bridge handles token refreshing automatically. If you are prompted to log in again, simply follow the browser flow. For the SA JWT path, the JWT has a 1-hour lifetime; restart the bridge if it expires.

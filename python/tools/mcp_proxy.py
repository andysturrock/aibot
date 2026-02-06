import argparse
import asyncio
import base64
import json
import logging
import os
import secrets
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlencode

import httpx
import keyring
from aiohttp import web
from dotenv import load_dotenv
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.server import Server
from mcp.server.stdio import stdio_server

# Deferred imports for faster startup
# import google.auth
# import google.auth.transport.requests
# from google.oauth2 import id_token

# Setup logging to stderr to avoid breaking stdio MCP communication
logging.basicConfig(
    level=logging.DEBUG,
    stream=sys.stderr,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("mcp-proxy")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("mcp").setLevel(logging.DEBUG)


def run_gcloud(args):
    """Run a gcloud command and return the parsed JSON output."""
    try:
        # We use --format=json to get structured data
        cmd = ["gcloud"] + list(args) + ["--format=json"]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        logger.error(f"gcloud command failed: {e.cmd}, stderr: {e.stderr}")
        return None
    except Exception as e:
        logger.error(f"Error running gcloud {args}: {e}")
        return None


def get_secret_payload(project_id, secret_name):
    """Fetch the payload of a secret from environment or Secret Manager."""
    # 1. Check for environment-injected secret data (stateless mode)
    # Use Base64 to ensure shell-safe passing of JSON data
    env_data_b64 = os.environ.get("IAP_SECRET_DATA")
    if env_data_b64:
        try:
            decoded = base64.b64decode(env_data_b64).decode("utf-8")
            data = json.loads(decoded)
            logger.info(
                "Successfully loaded IAP secrets from Base64 environment variable."
            )
            return data
        except Exception as e:
            logger.warning(f"Failed to decode IAP_SECRET_DATA from environment: {e}")

    # 2. Fallback to gcloud Secret Manager access
    # Use format=json to get the metadata which includes the base64 encoded data
    args = [
        "secrets",
        "versions",
        "access",
        "latest",
        f"--secret={secret_name}",
        f"--project={project_id}",
    ]
    res = run_gcloud(args)
    if not res:
        logger.error(
            f"Failed to access secret '{secret_name}' (latest version) in project '{project_id}'. Check permissions or gcloud auth."
        )
        return None
    if res and "payload" in res and "data" in res["payload"]:
        encoded_data = res["payload"]["data"]
        # Standard base64 padding check
        missing_padding = len(encoded_data) % 4
        if missing_padding:
            encoded_data += "=" * (4 - missing_padding)
        decoded_bytes = base64.b64decode(encoded_data)
        payload = json.loads(decoded_bytes.decode("utf-8"))
        logger.info(
            f"Successfully retrieved secret '{secret_name}' from Secret Manager."
        )
        return payload
    logger.warning(
        f"Secret '{secret_name}' retrieved but payload format was unexpected: {res}"
    )
    return None


def get_project_info():
    """Retrieve the current GCP project ID and number."""
    config = run_gcloud(["config", "list"])
    if not config:
        return None, None

    project_id = config.get("core", {}).get("project")
    if not project_id:
        return None, None

    proj_desc = run_gcloud(["projects", "describe", project_id])
    project_number = proj_desc.get("projectNumber") if proj_desc else None

    return project_id, project_number


def get_backend_id(project_id, backend_name):
    """Retrieve the generated ID for a global backend service."""
    backend = run_gcloud(
        ["compute", "backend-services", "describe", backend_name, "--global"]
    )
    if backend:
        return backend.get("id")
    return None


def verify_alignment(fqdn, project_id):
    """Verify that the FQDN resolves to an IP owned by the specified project."""
    try:
        ip = socket.gethostbyname(fqdn)
        logger.info(f"Resolved {fqdn} to {ip}")

        # Check global forwarding rules
        rules = run_gcloud(["compute", "forwarding-rules", "list", "--global"])
        if rules:
            for rule in rules:
                if rule.get("IPAddress") == ip:
                    logger.info(f"Verified IP {ip} is owned by project {project_id}")
                    return True

        logger.warning(
            f"No global forwarding rule found for IP {ip} in project {project_id}"
        )
        return False
    except Exception as e:
        logger.error(f"Alignment check failed: {e}")
        return False


async def proxy(url, token):
    """Run the MCP proxy server."""
    logger.info(f"Connecting to remote MCP server at {url}...")

    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with sse_client(url, headers=headers) as (read, write):
            async with ClientSession(read, write) as remote_session:
                await remote_session.initialize()
                logger.info("Remote session initialized successfully.")

                # Create the local server
                server = Server("mcp-proxy")

                @server.list_tools()
                async def list_tools():
                    try:
                        result = await remote_session.list_tools()
                        return result.tools
                    except Exception as e:
                        logger.error(f"Error in list_tools: {e}")
                        return []

                @server.call_tool()
                async def call_tool(name, arguments):
                    try:
                        return await remote_session.call_tool(name, arguments)
                    except Exception as e:
                        logger.error(f"Error in call_tool {name}: {e}")
                        from mcp.types import CallToolResult, TextContent

                        return CallToolResult(
                            content=[
                                TextContent(
                                    type="text", text=f"Error calling tool: {e}"
                                )
                            ],
                            isError=True,
                        )

                @server.list_resources()
                async def list_resources():
                    try:
                        result = await remote_session.list_resources()
                        return result.resources
                    except Exception as e:
                        logger.error(f"Error in list_resources: {e}")
                        return []

                @server.read_resource()
                async def read_resource(uri):
                    return await remote_session.read_resource(uri)

                @server.list_prompts()
                async def list_prompts():
                    result = await remote_session.list_prompts()
                    return result.prompts

                @server.get_prompt()
                async def get_prompt(name, arguments):
                    return await remote_session.get_prompt(name, arguments)

                # Start the local stdio server
                async with stdio_server() as (read_in, write_out):
                    logger.info("Local MCP server (stdio) is now running.")
                    await server.run(
                        read_in, write_out, server.create_initialization_options()
                    )
    except Exception as e:
        logger.error(f"Proxy bridge error: {e}")
        raise


SERVICE_NAME = "MyMCPDesktopClient"


def load_cached_tokens(audience: str):
    """Load cached tokens from environment, keyring, or file."""
    # 1. Check for environment-injected token data (highest priority for Docker/CI)
    # Use Base64 to ensure shell-safe passing of JSON data
    env_data_b64 = os.environ.get("IAP_TOKEN_DATA")
    if env_data_b64:
        try:
            decoded = base64.b64decode(env_data_b64).decode("utf-8")
            data = json.loads(decoded)
            logger.info(
                "Successfully loaded IAP tokens from Base64 environment variable."
            )
            return data
        except Exception as e:
            logger.warning(f"Failed to decode IAP_TOKEN_DATA from environment: {e}")

    # 2. Check OS keyring
    try:
        data = keyring.get_password(SERVICE_NAME, audience)
        if data:
            return json.loads(data)
    except Exception as e:
        logger.warning(f"Failed to load tokens from keyring: {e}")

    # 3. Fallback to file system
    return load_cached_tokens_from_file(audience)


def save_tokens(tokens, audience):
    """Save tokens after stripping non-essential fields like access_token."""
    # access_token is typically for Google APIs and isn't needed for IAP
    # Just keep refresh_token (to get more tokens) and id_token (for IAP)
    safe_tokens = {
        k: v
        for k, v in tokens.items()
        if k in ("id_token", "refresh_token", "expires_in", "token_type")
    }

    try:
        # We store the entire JSON blob as the 'password' for the audience key
        keyring.set_password(SERVICE_NAME, audience, json.dumps(safe_tokens))
        logger.info(f"Tokens saved to keyring for audience: {audience}")
    except Exception as e:
        logger.warning(f"Failed to save tokens to keyring: {e}")
        # Fallback to file system
        save_tokens_to_file(safe_tokens, audience)


def get_token_cache_path(audience: str) -> Path:
    """Get the path to the token cache file for a specific audience."""
    import hashlib

    audience_hash = hashlib.sha256(audience.encode()).hexdigest()[:12]
    cache_dir = Path.home() / ".cache" / "mcp-proxy"
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Ensure cache directory has restricted permissions
    try:
        os.chmod(cache_dir, 0o700)
    except PermissionError:
        logger.warning(
            f"Unable to change permissions on cache directory {cache_dir}. This is expected if the directory is mounted from a host with restricted permissions."
        )
    except Exception as e:
        logger.warning(f"Unexpected error when chmod-ing {cache_dir}: {e}")
    return cache_dir / f"tokens_{audience_hash}.json"


def load_cached_tokens_from_file(audience: str):
    """Load tokens from a local JSON file as a fallback."""
    path = get_token_cache_path(audience)
    if path.exists():
        try:
            logger.info(f"Loading cached tokens from file: {path}")
            with open(path) as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load tokens from file {path}: {e}")
    return {}


def save_tokens_to_file(tokens, audience):
    """Save tokens to a local JSON file with restricted (0600) permissions."""
    path = get_token_cache_path(audience)
    try:
        # Create/open with 0600 permissions
        with os.fdopen(
            os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w"
        ) as f:
            json.dump(tokens, f)
        logger.info(f"Tokens saved to file: {path} (permissions: 0600)")
    except Exception as e:
        logger.error(f"Failed to save tokens to file {path}: {e}")


def check_token_expiry(token):
    """Return True if token is expired or close to expiring."""
    if not token:
        return True
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return True
        payload_b64 = parts[1]
        payload_b64 += "=" * (4 - len(payload_b64) % 4)
        payload_json = base64.b64decode(payload_b64).decode("utf-8")
        payload = json.loads(payload_json)
        # Buffer of 60 seconds
        return payload.get("exp", 0) < (time.time() + 60)
    except Exception:
        return True


async def refresh_iap_token(refresh_token, client_id, client_secret, audience):
    """Use refresh token to get a new ID token."""
    logger.info("Attempting to refresh IAP token...")
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post("https://oauth2.googleapis.com/token", data=data)
        if resp.status_code == 200:
            new_tokens = resp.json()
            # If we didn't get a new refresh token, keep the old one
            if "refresh_token" not in new_tokens:
                new_tokens["refresh_token"] = refresh_token
            save_tokens(new_tokens, audience)
            return new_tokens.get("id_token")
        else:
            logger.error(f"Failed to refresh token: {resp.text}")
            return None


async def get_iap_client_secrets(
    project_id, override_client_id=None, override_client_secret=None, secret_name=None
):
    """Retrieve IAP client ID and secret, falling back to Secret Manager."""
    client_id = override_client_id or os.environ.get("IAP_CLIENT_ID")
    client_secret = override_client_secret or os.environ.get("IAP_CLIENT_SECRET")

    if (not client_id or not client_secret) and secret_name:
        logger.info(
            f"Fetching IAP client secrets from Secret Manager ('{secret_name}')..."
        )
        mcp_config = get_secret_payload(project_id, secret_name)
        if mcp_config:
            client_id = client_id or mcp_config.get("iapClientId")
            client_secret = client_secret or mcp_config.get("iapClientSecret")

    return client_id, client_secret


async def fetch_iap_token(
    project_id,
    audience,
    override_client_id=None,
    override_client_secret=None,
    secret_name=None,
):
    """Fetch an IAP identity token, with browser fallback and caching."""
    # Method 1: Browser Flow with Caching (Fastest)
    cached = load_cached_tokens(audience)
    if cached:
        token = cached.get("id_token")
        if not check_token_expiry(token):
            logger.info("Using valid identity token (Environment/Keyring/File).")
            return token

        # Token expired, try refresh
        refresh_token = cached.get("refresh_token")
        if refresh_token:
            client_id, client_secret = await get_iap_client_secrets(
                project_id, override_client_id, override_client_secret, secret_name
            )
            if client_id and client_secret:
                new_token = await refresh_iap_token(
                    refresh_token, client_id, client_secret, audience
                )
                if new_token:
                    return new_token

    # If we are in a headless environment (pumping variables),
    # we should NOT try to fall back to Metadata or Browser.
    if os.environ.get("IAP_TOKEN_DATA") or os.environ.get("IAP_SECRET_DATA"):
        logger.error(
            "Headless Mode: Injected credentials were invalid or expired, and no refresh token exists. Cannot proceed with browser flow."
        )
        return None

    # Method 2: Try standard google-auth/metadata server (deferred imports)
    try:
        import google.auth.transport.requests
        from google.oauth2 import id_token

        auth_req = google.auth.transport.requests.Request()
        return id_token.fetch_id_token(auth_req, audience)
    except Exception:
        pass

    logger.info("Falling back to browser-based OAuth flow...")

    # Get Client Secrets for browser flow
    client_id, client_secret = await get_iap_client_secrets(
        project_id, override_client_id, override_client_secret, secret_name
    )

    if not client_id or not client_secret:
        logger.error(
            "IAP Client ID or Secret missing. Ensure you have 'gcloud auth login' and Secret Manager access."
        )
        return None

    # 2. Start local server to receive callback
    state = secrets.token_urlsafe(16)
    redirect_uri = "http://localhost:8081/callback"
    received_code = None

    async def handle_callback(request):
        nonlocal received_code
        if request.query.get("state") != state:
            return web.Response(text="Invalid state parameter", status=400)
        received_code = request.query.get("code")
        return web.Response(
            text="Authentication successful! You can close this window."
        )

    try:
        app = web.Application()
        app.router.add_get("/callback", handle_callback)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", 8081)
        await site.start()
        logger.info("Local listener started on http://localhost:8081")
    except Exception as e:
        logger.warning(
            f"Could not start local listener: {e}. You will need to manually paste the callback URL."
        )
        runner = None

    # 3. Form Auth URL
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email",
        "state": state,
        "nonce": secrets.token_urlsafe(16),
        "access_type": "offline",
        "prompt": "consent",
    }
    auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    logger.info(f"Please log in at: {auth_url}")

    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    # 4. Wait for code (with manual fallback)
    if runner:
        logger.info(
            "Waiting for authentication callback (or paste the full callback URL below)..."
        )
    else:
        logger.info(
            "Please paste the full callback URL (the one starting with http://localhost:8081/callback) here: "
        )

    # We use a loop to allow for both async callback and a timeout
    for _ in range(300):  # 5 minute timeout
        if received_code:
            break
        # Check if user provided manual input via stdin if we were in a mode that allowed it
        # But since we are likely in a non-interactive pipe, we stick to the callback.
        # However, for manual CLI usage, this is helpful.
        await asyncio.sleep(1)

    if runner:
        await runner.cleanup()

    if not received_code:
        logger.error("Timed out waiting for authentication.")
        return None

    # 5. Exchange code for token
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": received_code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        if resp.status_code != 200:
            logger.error(f"Token exchange failed: {resp.text}")
            return None

        tokens = resp.json()
        save_tokens(tokens, audience)
        return tokens.get("id_token")


async def main():
    parser = argparse.ArgumentParser(description="MCP Bridge for IAP-protected servers")
    parser.add_argument("--url", required=True, help="SSE URL of the remote MCP server")
    parser.add_argument(
        "--project", help="GCP Project ID (optional, defaults to gcloud config)"
    )
    parser.add_argument("--backend", help="Backend service name for audience discovery")
    parser.add_argument("--audience", help="Explicit IAP audience (optional)")
    parser.add_argument(
        "--secret-name", help="Secret Manager name for IAP client configuration"
    )
    parser.add_argument("--client-id", help="Override OAuth Client ID")
    parser.add_argument("--client-secret", help="Override OAuth Client Secret")
    parser.add_argument("--env", help="Path to a .env file to load")
    parser.add_argument(
        "--skip-alignment",
        action="store_true",
        help="Skip FQDN-Project alignment check",
    )
    args = parser.parse_args()

    if args.env:
        load_dotenv(args.env)

    # 1. Project and Audience Setup
    project_id = args.project
    project_number = None
    audience = args.audience

    # 2. Acquire IAP Identity Token
    logger.debug("Acquiring IAP identity token...")

    token = None
    if not token:
        # Slow path: Need to discover or do full auth
        if not project_id:
            project_id, project_number = get_project_info()

        if not project_id:
            logger.error("Error: Could not determine GCP project ID. Use --project.")
            sys.exit(1)

        # IAP Audience Discovery
        if not audience:
            logger.info(
                f"Discovering IAP audience for backend '{args.backend}' in project '{project_id}'..."
            )
            if not project_number:
                proj_desc = run_gcloud(["projects", "describe", project_id])
                project_number = proj_desc.get("projectNumber") if proj_desc else None

            backend_id = get_backend_id(project_id, args.backend)
            if not backend_id or not project_number:
                logger.error(
                    f"Error: Could not discover audience for '{args.backend}'."
                )
                sys.exit(1)
            audience = f"/projects/{project_number}/global/backendServices/{backend_id}"
            logger.info(f"Discovered audience: {audience}")

        # Acquire token with full logic
        token = await fetch_iap_token(
            project_id, audience, args.client_id, args.client_secret, args.secret_name
        )

    if not token:
        logger.error("Error: Failed to acquire IAP token.")
        sys.exit(1)

    # 5. Execute Proxy
    try:
        logger.info(f"Starting proxy to {args.url}")
        await proxy(args.url, token)
    except Exception as e:
        logger.error(f"Proxy execution failed: {e}")
        import traceback

        logger.error(traceback.format_exc())
        sys.exit(1)
    finally:
        logger.info("Bridge execution finished.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Shutting down bridge...")
        sys.exit(0)

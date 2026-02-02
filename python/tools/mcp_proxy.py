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
from urllib.parse import urlencode

import httpx
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
        logger.error(f"gcloud command failed: {e.stderr}")
        return None
    except Exception as e:
        logger.error(f"Error running gcloud: {e}")
        return None


def get_secret_payload(project_id, secret_name):
    """Fetch the payload of a secret from Secret Manager."""
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
    if res and "payload" in res and "data" in res["payload"]:
        encoded_data = res["payload"]["data"]
        # Standard base64 padding check
        missing_padding = len(encoded_data) % 4
        if missing_padding:
            encoded_data += "=" * (4 - missing_padding)
        decoded_bytes = base64.b64decode(encoded_data)
        return json.loads(decoded_bytes.decode("utf-8"))
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
    async with sse_client(url, headers={"Authorization": f"Bearer {token}"}) as (
        read,
        write,
    ):
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
                            TextContent(type="text", text=f"Error calling tool: {e}")
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


def get_cache_path():
    """Return the path to the token cache file."""
    # Use explicit home if available
    home = os.environ.get("HOME", os.path.expanduser("~"))
    base_dir = os.path.join(home, ".config/gcloud")
    os.makedirs(base_dir, exist_ok=True)
    path = os.path.join(base_dir, "mcp_bridge_tokens.json")
    logger.debug(f"Using cache path: {path}")
    return path


def load_cached_tokens():
    """Load cached tokens from disk."""
    path = get_cache_path()
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load cached tokens: {e}")
    return {}


def save_tokens(tokens, audience):
    """Save tokens to disk securely."""
    path = get_cache_path()
    try:
        tokens["audience"] = audience
        # Use os.open to ensure the file is created with 0o600 from the start
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(tokens, f)
    except Exception as e:
        logger.warning(f"Failed to save tokens securely: {e}")


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
    cached = load_cached_tokens()
    if cached.get("audience") == audience:
        token = cached.get("id_token")
        if not check_token_expiry(token):
            logger.info("Using valid cached IAP token.")
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
        site = web.TCPSite(runner, "localhost", 8081)
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

    # Fast path: check cache first before doing any gcloud calls
    cached = load_cached_tokens()
    token = None

    if audience and cached.get("audience") == audience:
        token = cached.get("id_token")
        if not check_token_expiry(token):
            logger.info("Using valid cached IAP token (fast path).")
        else:
            token = None  # Needs refresh, fall through to fetch_iap_token

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

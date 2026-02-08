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

# errors when anyio/asyncio tries to log to stderr after it's been closed by stdio_server.
# We use os.dup2 to ensure C-level writes to fd 2 also go to the file.
try:
    stderr_fd = os.open(
        "/tmp/mcp_proxy_stderr.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    )
    os.dup2(stderr_fd, 2)
    sys.stderr = os.fdopen(stderr_fd, "w", buffering=1)
    print(
        "DEBUG: stderr redirected to /tmp/mcp_proxy_stderr.log via os.dup2",
        file=sys.stderr,
    )
except Exception:
    # If this fails, we can't do much, but at least we can try to proceed
    pass

import webbrowser
from pathlib import Path
from urllib.parse import urlencode

import httpx
import keyring
from aiohttp import web
from dotenv import load_dotenv
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from mcp.server import Server
from mcp.types import CallToolResult, TextContent

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("/tmp/mcp_proxy_debug.log", mode="a"),
    ],
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
    except (subprocess.CalledProcessError, json.JSONDecodeError) as e:
        logger.error(f"Error running gcloud {' '.join(args)}: {e}")
        return None
    except Exception as e:
        logger.error(f"Error running gcloud {args}: {e}")
        return None


def format_slack_messages(raw_json: str) -> str:
    """Format stringified JSON Slack messages into a human-readable Markdown table."""
    try:
        if not raw_json or not isinstance(raw_json, str):
            return str(raw_json)

        messages = json.loads(raw_json)
        if not isinstance(messages, list):
            return raw_json

        if not messages:
            return "No Slack messages found."

        md = "### Slack Search Results\n\n"
        md += "| Date | User | Channel | Message |\n"
        md += "| :--- | :--- | :--- | :--- |\n"

        for msg in messages:
            try:
                ts_val = msg.get("ts", "0")
                ts = float(ts_val)
                date_str = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))
            except (ValueError, TypeError):
                date_str = "Unknown Date"

            user = msg.get("user_name", "Unknown")
            channel = msg.get("channel_name", "Unknown")
            text = msg.get("text", "").replace("\n", " ").replace("\r", " ")

            # Escape pipe characters for markdown table
            text = text.replace("|", "\\|")

            # Truncate text for table readability
            display_text = text[:120] + "..." if len(text) > 120 else text

            url = msg.get("url", "#")

            md += f"| {date_str} | {user} | #{channel} | [{display_text}]({url}) |\n"

        return md
    except Exception as e:
        logger.error(f"Error formatting slack messages: {e}")
        return str(raw_json)


def get_secret_payload(project_id, secret_name):
    """Fetch the payload of a secret from environment or Secret Manager."""
    # 1. Check for environment-injected secret data (stateless mode)
    env_data_b64 = os.environ.get("IAP_SECRET_DATA")
    if env_data_b64:
        try:
            decoded = base64.b64decode(env_data_b64).decode("utf-8")
            data = json.loads(decoded)
            logger.info("Successfully loaded IAP secrets from environment variable.")
            return data
        except Exception as e:
            logger.warning(f"Failed to decode IAP_SECRET_DATA: {e}")

    # 2. Fallback to gcloud Secret Manager access
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
            f"Failed to access secret '{secret_name}' in project '{project_id}'."
        )
        return None

    if res and "payload" in res and "data" in res["payload"]:
        encoded_data = res["payload"]["data"]
        missing_padding = len(encoded_data) % 4
        if missing_padding:
            encoded_data += "=" * (4 - missing_padding)
        decoded_bytes = base64.b64decode(encoded_data)
        payload = json.loads(decoded_bytes.decode("utf-8"))

        # Robustness: Check for both camelCase and underscore keys
        client_id = payload.get("iapClientId") or payload.get("client_id")
        client_secret = payload.get("iapClientSecret") or payload.get("client_secret")

        # Normalize into a predictable format for the rest of the script
        normalized = {"iapClientId": client_id, "iapClientSecret": client_secret}
        logger.info(f"Successfully retrieved and normalized secret '{secret_name}'.")
        return normalized

    logger.warning(
        f"Secret '{secret_name}' retrieved but payload format was unexpected."
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


def process_tool_result(name, result):
    """
    Process result from remote MCP tool call and enhance for local display.
    Ensures both a Markdown summary and raw JSON are returned in 'content'.
    """
    # Use direct dictionary mapping to ensure all fields (including structuredContent) are preserved
    # We must convert content items to dicts because they might be Pydantic models (like TextContent)
    # which are not directly JSON serializable by the stdio transport.
    # Prepare final serializable dictionary
    final_res = {
        "content": [{"type": c.type, "text": c.text} for c in result.content],
        "isError": result.isError,
    }

    # Ensure the output has 'structuredContent' and 'content' as requested
    structured_data = getattr(result, "structuredContent", None)
    if not structured_data and hasattr(result, "model_extra"):
        structured_data = result.model_extra.get("structuredContent")

    search_json = None
    if (
        structured_data
        and isinstance(structured_data, dict)
        and "result" in structured_data
    ):
        search_json = structured_data["result"]
    elif hasattr(result, "model_extra") and "result" in result.model_extra:
        search_json = result.model_extra["result"]

    if search_json is not None:
        # 1. Update structuredContent
        final_res["structuredContent"] = {"result": search_json}
        final_res["result"] = (
            json.dumps(search_json)
            if isinstance(search_json, list | dict)
            else str(search_json)
        )

        # 2. Re-synthesize content block with DUAL output: Markdown + Raw JSON
        formatted_markdown = search_json
        if "search_slack" in name or "slack_search" in name:
            # format_slack_messages handles list/dict to markdown table conversion
            raw_str = (
                json.dumps(search_json)
                if isinstance(search_json, list | dict)
                else str(search_json)
            )
            formatted_markdown = format_slack_messages(raw_str)

        # Item 0: Human-friendly Markdown
        new_content = [{"type": "text", "text": formatted_markdown}]

        # Item 1: Raw JSON string (user requested enhancement)
        raw_data_str = json.dumps(search_json, indent=2)
        new_content.append(
            {"type": "text", "text": f"#### 📄 Raw Data\n```json\n{raw_data_str}\n```"}
        )

        final_res["content"] = new_content
    elif not result.isError:
        # Fallback if no structured result
        final_res["result"] = ""
        final_res["structuredContent"] = {"result": ""}

    return final_res


async def proxy(url, token):
    """Run the MCP proxy server."""
    logger.info(f"Connecting to remote MCP server at {url}...")

    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with sse_client(url, headers=headers) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as remote_session:
                await remote_session.initialize()
                logger.info("Remote session initialized successfully.")

                # Create the local server
                server = Server("mcp-proxy")

                @server.list_tools()
                async def list_tools():
                    try:
                        # Use the remote_session directly within this scope
                        result = await remote_session.list_tools()
                        tool_names = [t.name for t in result.tools]
                        logger.info(f"Discovered tools: {tool_names}")
                        return result.tools
                    except Exception as e:
                        logger.error(f"Error in list_tools: {e}")
                        return []

                @server.call_tool()
                async def call_tool(name, arguments):
                    try:
                        logger.info(f"Calling tool: {name} with arguments: {arguments}")
                        # Ensure the remote_session is still active
                        result = await remote_session.call_tool(name, arguments)
                        logger.info(f"Got result from remote tool: {name}")

                        # TEMPORARY: Bypass processing to isolate crash
                        return result

                        # processed = process_tool_result(name, result)
                        # return processed
                    except BaseException as e:
                        logger.error(f"Error in call_tool: {e}")
                        # CRITICAL: Do NOT let any exception escape call_tool as it will crash the stdio bridge
                        # We avoid logger.error here as it might trigger the Bad file descriptor OSError
                        return CallToolResult(
                            content=[
                                TextContent(
                                    type="text",
                                    text="Bridge Error: Internal exception during tool execution. See stderr if available.",
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
                # We use the standard stdio_server from mcp.server.stdio
                from mcp.server.stdio import stdio_server

                async with stdio_server() as (read_in, write_out):
                    logger.info("Local MCP server (stdio) is now running.")
                    # initialization_options is required for the server to run correctly
                    init_options = server.create_initialization_options()
                    await server.run(read_in, write_out, init_options)
    except BaseException as e:
        logger.exception(f"CRITICAL: Proxy bridge error: {type(e).__name__}: {e}")
        if hasattr(e, "exceptions"):
            for sub_e in e.exceptions:
                logger.error(f"Sub-exception: {type(sub_e).__name__}: {sub_e}")
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
    """Save tokens with Keyring priority and File Cache fallback."""
    safe_tokens = {
        k: v
        for k, v in tokens.items()
        if k in ("id_token", "refresh_token", "expires_in", "token_type")
    }

    # 1. Try Keyring
    try:
        keyring.set_password(SERVICE_NAME, audience, json.dumps(safe_tokens))
        logger.info(f"Tokens saved to keyring for audience: {audience}")
    except Exception as e:
        logger.warning(
            f"Failed to save tokens to keyring: {e}. Falling back to file cache."
        )
        # 2. Fallback to file cache
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
    try:
        path = get_token_cache_path(audience)
        if path.exists():
            logger.info(f"Loading cached tokens from file: {path}")
            with open(path) as f:
                return json.load(f)
    except (PermissionError, Exception) as e:
        logger.warning(f"Failed to load tokens from file: {e}")
    return {}


def save_tokens_to_file(tokens, audience):
    """Save tokens to a local JSON file with restricted (0600) permissions."""
    try:
        path = get_token_cache_path(audience)
        # Create/open with 0600 permissions
        with os.fdopen(
            os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w"
        ) as f:
            json.dump(tokens, f)
        logger.info(f"Tokens saved to file: {path} (permissions: 0600)")
    except Exception as e:
        logger.warning(f"Failed to save tokens to file: {e}")


def check_token_expiry(token):
    """Return True if token is expired or close to expiring."""
    if not token:
        return True
    try:
        parts = token.split(".")
        if len(parts) != 3:
            logger.debug("Token does not have 3 parts.")
            return True
        payload_b64 = parts[1]
        payload_b64 += "=" * (4 - len(payload_b64) % 4)
        payload_json = base64.b64decode(payload_b64).decode("utf-8")
        payload = json.loads(payload_json)

        exp = payload.get("exp", 0)
        now = time.time()
        # Buffer of 60 seconds
        if exp < (now + 60):
            logger.warning(
                f"Token is expired or expiring soon. Exp: {exp}, Now: {now}, Diff: {exp - now}"
            )
            return True
        return False
    except Exception as e:
        logger.warning(f"Error checking token expiry: {e}")
        return True


async def refresh_iap_token(refresh_token, client_id, client_secret, audience):
    """Use refresh token to get a new ID token."""
    logger.info("Attempting to refresh IAP token via Google APIs...")
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
            logger.info("Token refresh successful.")
            return new_tokens.get("id_token")
        else:
            logger.error(f"Failed to refresh token: {resp.text}")
            return None


async def fetch_iap_token_via_browser(project_id, audience, secret_name):
    """Run interactive host-side browser OAuth flow."""
    client_id, client_secret = await get_iap_client_secrets(
        project_id, secret_name=secret_name
    )

    if not client_id or not client_secret:
        logger.error(
            "Error: IAP Client ID or Secret missing. Cannot start browser flow."
        )
        return None

    state = secrets.token_urlsafe(16)
    redirect_uri = "http://localhost:8081/callback"
    received_code = None

    async def handle_callback(request):
        nonlocal received_code
        if request.query.get("state") != state:
            return web.Response(text="Invalid state parameter", status=400)
        received_code = request.query.get("code")
        return web.Response(
            text="Authentication successful! You can now close this tab."
        )

    logger.info("Starting local callback server on port 8081...")
    app = web.Application()
    app.router.add_get("/callback", handle_callback)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8081)
    await site.start()

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

    print(
        f"\n! ACTION REQUIRED: Please log in via your browser:\n{auth_url}\n",
        file=sys.stderr,
    )
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    logger.info("Waiting for authentication callback...")
    for _ in range(300):  # 5 minute timeout
        if received_code:
            break
        await asyncio.sleep(1)

    await runner.cleanup()

    if not received_code:
        logger.error("Timeout waiting for browser authentication.")
        return None

    logger.info("Exchanging authorization code for tokens...")
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
    # 1. Load cached tokens (Keyring -> File)
    cached = load_cached_tokens(audience)
    if cached:
        token = cached.get("id_token")
        if not check_token_expiry(token):
            logger.info("Using valid identity token from cache.")
            return token

        # Token expired, try refresh if we have a refresh token
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

    # 2. Last Resort: Interactive Browser Flow (Host side only)
    logger.info("Falling back to interactive browser-based OAuth flow...")
    return await fetch_iap_token_via_browser(project_id, audience, secret_name)


async def main():
    parser = argparse.ArgumentParser(description="Native MCP Bridge for IAP")
    parser.add_argument("--url", help="SSE URL of the remote MCP server")
    parser.add_argument(
        "--env", choices=["beta", "prod"], help="Environment preset (beta or prod)"
    )
    parser.add_argument("--project", help="GCP Project ID")
    parser.add_argument(
        "--backend", default="slack-search-mcp", help="Backend service name"
    )
    parser.add_argument("--audience", help="Explicit IAP audience")
    parser.add_argument(
        "--secret-name", default="slack-search-mcp-config", help="Secret Manager name"
    )
    parser.add_argument("--client-id", help="Override OAuth Client ID")
    parser.add_argument("--client-secret", help="Override OAuth Client Secret")
    parser.add_argument("--skip-alignment", action="store_true")
    args = parser.parse_args()

    # 1. Environment Loading
    if args.env:
        # Detect project root (parent of python/ directory)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.abspath(os.path.join(script_dir, "..", ".."))

        # Load dotenv for the specific environment if it exists
        env_file = os.path.join(project_root, f".env.{args.env}")
        if os.path.exists(env_file):
            logger.info(f"Loading environment from {env_file}")
            load_dotenv(env_file)
        else:
            logger.warning(f"Warning: Environment file {env_file} not found.")

    # 2. URL Derivation (CLI first, then Env, then construct from FQDN)
    url = args.url or os.environ.get("IAP_URL") or os.environ.get("SSE_URL")

    if not url and os.environ.get("CUSTOM_FQDN"):
        url = f"https://{os.environ.get('CUSTOM_FQDN')}/mcp/sse"
        logger.info(f"Constructed IAP URL from CUSTOM_FQDN: {url}")

    if not url:
        logger.error(
            "Error: --url is required (or set IAP_URL/CUSTOM_FQDN in your .env file)."
        )
        sys.exit(1)

    # 1. Project and Audience Setup
    project_id = args.project
    project_number = None
    audience = args.audience

    if not project_id:
        project_id, project_number = get_project_info()

    if not project_id:
        logger.error("Error: Could not determine GCP project. Use --project.")
        sys.exit(1)

    # IAP Audience Discovery
    if not audience:
        if args.backend:
            logger.info(f"Discovering IAP audience for backend '{args.backend}'...")
            if not project_number:
                proj_desc = run_gcloud(["projects", "describe", project_id])
                project_number = proj_desc.get("projectNumber") if proj_desc else None

            backend_id = get_backend_id(project_id, args.backend)
            if backend_id and project_number:
                audience = (
                    f"/projects/{project_number}/global/backendServices/{backend_id}"
                )
                logger.info(f"Discovered audience: {audience}")

        # Final fallback to client ID as audience if provided
        if not audience:
            audience = (
                args.client_id
                or os.environ.get("IAP_AUDIENCE")
                or os.environ.get("IAP_CLIENT_ID")
            )

    if not audience:
        logger.error(
            "Error: Could not determine IAP audience. Use --audience or --backend."
        )
        sys.exit(1)

    # 2. Acquire IAP Identity Token
    token = await fetch_iap_token(
        project_id, audience, args.client_id, args.client_secret, args.secret_name
    )

    if not token:
        logger.error("Error: Failed to acquire IAP token.")
        sys.exit(1)

    # 3. Execute Proxy
    try:
        logger.info(f"Starting native bridge to {url}")
        await proxy(url, token)
    except Exception as e:
        logger.error(f"Proxy execution failed: {e}")
        sys.exit(1)
    finally:
        logger.info("Bridge execution finished.")


if __name__ == "__main__":
    with open("/tmp/mcp_proxy_debug.log", "a") as f:
        f.write(f"\n--- SCRIPT START: {time.ctime()} ---\n")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Shutting down bridge...")
        sys.exit(0)

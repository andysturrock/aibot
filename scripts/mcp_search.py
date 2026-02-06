import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(query: str, env_file: str = None):
    # Load environment variables
    if env_file:
        load_dotenv(env_file)
    else:
        # Try common filenames in order
        for f in [".env", ".env.beta", ".env.prod"]:
            if os.path.exists(f):
                load_dotenv(f)
                break

    # Configuration - Require environment variables matching project standards
    project_id = (
        os.environ.get("PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT", "")
    ).strip(" \"'")
    # IAP_AUDIENCE is the specific Backend Service ID (preferred)
    audience = (
        os.environ.get("IAP_AUDIENCE") or os.environ.get("IAP_CLIENT_ID", "")
    ).strip(" \"'")
    custom_fqdn = (os.environ.get("CUSTOM_FQDN", "")).strip(" \"'")

    missing = []
    if not project_id:
        missing.append("PROJECT_ID")
    if not audience:
        missing.append("IAP_AUDIENCE or IAP_CLIENT_ID")
    if not custom_fqdn:
        missing.append("CUSTOM_FQDN")

    if missing:
        print(f"Error: Missing required environment variables: {', '.join(missing)}")
        print(
            "\nEnsure you have a valid .env.beta or .env.prod file in this directory."
        )
        print("Note: IAP_AUDIENCE should be the Backend Service resource path or ID.")
        sys.exit(1)

    url = f"https://{custom_fqdn}/mcp/sse"
    print(f"Connecting to MCP bridge for {url}...")

    # Fetch IAP client secrets and tokens from host to pass into the Docker container.
    iap_token_data_b64 = None
    iap_secret_data_b64 = None
    try:
        import base64
        import hashlib
        import json
        import subprocess
        from pathlib import Path

        import keyring

        # 1. Fetch Tokens (Keyring or File Cache)
        SERVICE_NAME = "MyMCPDesktopClient"
        token_data = keyring.get_password(SERVICE_NAME, audience)

        if not token_data:
            # Fallback to host-side file cache
            audience_hash = hashlib.sha256(audience.encode()).hexdigest()[:12]
            cache_path = (
                Path.home() / ".cache" / "mcp-proxy" / f"tokens_{audience_hash}.json"
            )
            if cache_path.exists():
                print(f"Token not in keyring, but found in host cache: {cache_path}")
                token_data = cache_path.read_text()

        if token_data:
            print("Found valid session on host. Syncing to Docker (Base64)...")
            iap_token_data_b64 = base64.b64encode(token_data.encode("utf-8")).decode(
                "utf-8"
            )

        # 2. Fetch Secrets from Secret Manager (Host-side)
        secret_name = "AIBot-shared-config"
        print(f"Fetching IAP client secrets from Secret Manager ('{secret_name}')...")
        cmd = [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={secret_name}",
            f"--project={project_id}",
            "--format=json",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            res = json.loads(result.stdout)
            if "payload" in res and "data" in res["payload"]:
                # The data is already base64 encoded by gcloud in the JSON output,
                # but we need the raw payload to encode it our way or just pass it if it's already a string.
                # Actually, our proxy expects Base64 of the JSON string.
                encoded_data = res["payload"]["data"]
                missing_padding = len(encoded_data) % 4
                if missing_padding:
                    encoded_data += "=" * (4 - missing_padding)
                raw_payload = base64.b64decode(encoded_data).decode("utf-8")
                iap_secret_data_b64 = base64.b64encode(
                    raw_payload.encode("utf-8")
                ).decode("utf-8")
                print(
                    "Successfully fetched IAP secrets from host and encoded as Base64."
                )
        else:
            print(f"Warning: Could not fetch secrets from host gcloud: {result.stderr}")

    except Exception as e:
        print(
            f"Warning: Host-side prep failed (will fallback to container-side auth): {e}"
        )

    docker_args = [
        "run",
        "-i",
        "--rm",
        "-p",
        "8081:8081",
    ]

    if iap_token_data_b64:
        docker_args.extend(["-e", f"IAP_TOKEN_DATA={iap_token_data_b64}"])
    if iap_secret_data_b64:
        docker_args.extend(["-e", f"IAP_SECRET_DATA={iap_secret_data_b64}"])

    docker_args.extend(
        [
            "mcp-proxy-bridge",
            "--url",
            url,
            "--project",
            project_id,
            "--audience",
            audience,
            "--secret-name",
            "AIBot-shared-config",
            "--skip-alignment",
        ]
    )

    print("\nExecuting Docker command:")
    print(
        f"docker {' '.join([arg if 'DATA=' not in arg else arg[:20]+'...' for arg in docker_args])}\n"
    )

    server_params = StdioServerParameters(
        command="docker",
        args=docker_args,
    )

    try:
        # Use a timeout to prevent hanging if the bridge or server is unresponsive
        async with asyncio.timeout(60):
            async with stdio_client(server_params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()

                    tool_name = "search_slack_messages"
                    print(f"Searching for '{query}'...")
                    result = await session.call_tool(tool_name, {"query": query})

                    print("\n" + "=" * 40)
                    print(f" SEARCH RESULTS FOR: {query}")
                    print("=" * 40 + "\n")

                    if hasattr(result, "content"):
                        for item in result.content:
                            if hasattr(item, "text"):
                                print(item.text)
                            else:
                                print(item)
                    else:
                        print(result)
                    print("\n" + "=" * 40)

    except TimeoutError:
        print(
            "\nError: The search operation timed out. This may indicate a network issue or auth failure."
        )
    except Exception as e:
        print(f"\nError: {e}")
        print("\nPossible issues:")
        print(
            "1. Cloud Armor/WAF blocking the request (especially for natural language queries)."
        )
        print("2. IAP authentication failure (check your token cache).")
        print("3. Remote server is down or unreachable.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Search Slack messages using the Docker-based MCP bridge.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Environment Variables Required:
  PROJECT_ID           GCP Project ID (e.g., ab-ai-test-392416)
  IAP_CLIENT_ID        IAP OAuth Client ID (audience) for the backend service
  CUSTOM_FQDN          The custom domain for the AIBot (e.g., aibot.dev.slackapps.atombank.co.uk)

Note: Sourcing a .env file (e.g., 'source .env.beta') is the easiest way to set these.
        """,
    )
    parser.add_argument("query", help="The search query (e.g., 'ISA launch date')")
    parser.add_argument(
        "--env",
        help="Path to environment file (default: matches .env, .env.beta, or .env.prod)",
    )

    args = parser.parse_args()
    asyncio.run(run(args.query, args.env))

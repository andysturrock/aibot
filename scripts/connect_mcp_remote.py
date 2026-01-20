
import asyncio
import os
import sys
import logging
import json
import subprocess
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from google.auth.transport.requests import Request
import google.oauth2.id_token
import httpx

# Add shared library to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../python/libs/shared")))

from shared.gcp_api import get_secret_value, get_id_token

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("remote_debug")

# Load .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
    logger.info("Loaded .env file")
except ImportError:
    logger.warning("python-dotenv not installed, skipping .env load")

# Configuration
os.environ["K_SERVICE"] = "slack-search-mcp" # Fixes shared lib warning/fallback

CUSTOM_FQDN = os.environ.get("CUSTOM_FQDN")
if not CUSTOM_FQDN:
    logger.error("CUSTOM_FQDN environment variable is required.")
    exit(1)

MCP_URL = f"https://{CUSTOM_FQDN}/mcp/sse"


async def run_test():
    # Ensure PROJECT_ID is set
    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("PROJECT_ID")
    
    if project_id:
        os.environ["GOOGLE_CLOUD_PROJECT"] = project_id
    else:
        # Try to get from gcloud config
        try:
             proj = subprocess.check_output(["gcloud", "config", "get-value", "project"], text=True).strip()
             os.environ["GOOGLE_CLOUD_PROJECT"] = proj
             logger.info(f"Set GOOGLE_CLOUD_PROJECT to {proj}")
        except:
             logger.warning("Could not set GOOGLE_CLOUD_PROJECT from env or gcloud.")

    # 1. Fetch Secrets
    try:
        logger.info("Fetching secrets...")
        # iapClientId is in slack-search-mcp-config
        from shared.gcp_api import _access_secret
        mcp_secrets = await _access_secret(os.environ["GOOGLE_CLOUD_PROJECT"], "slack-search-mcp-config")
        if not mcp_secrets:
            logger.error("❌ Could not fetch 'slack-search-mcp-config' secret.")
            return

        iap_client_id = mcp_secrets.get("iapClientId")
        if not iap_client_id:
            logger.error("❌ 'iapClientId' not found in mcp-config.")
            return
        
        logger.info(f"Using IAP Client ID: {iap_client_id}")

    except Exception as e:
        logger.error(f"Error fetching secrets: {e}")
        return

    # 2. Generate ID Token
    # Try User Auth first (for local debugging)
    logger.info("Generating ID Token via gcloud (User Credential)...")
    try:
        cmd = [
            "gcloud", "auth", "print-identity-token", 
            f"--audiences={iap_client_id}",
            "--include-email"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        id_token_val = result.stdout.strip()
        logger.info("Generated ID Token via gcloud (User).")
    except Exception as e:
        logger.warning(f"Failed to generate User ID Token: {e}")
        # Fallback to Impersonation
        logger.info("Trying gcloud CLI with IMPERSONATION details...")
        project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
        sa_email = f"aibot-logic@{project_id}.iam.gserviceaccount.com"
        try:
             cmd = [
                "gcloud", "auth", "print-identity-token", 
                f"--audiences={iap_client_id}",
                f"--impersonate-service-account={sa_email}",
                "--include-email"
             ]
             result = subprocess.run(cmd, capture_output=True, text=True, check=True)
             id_token_val = result.stdout.strip()
             logger.info(f"Generated ID Token via gcloud (Impersonating {sa_email}).")
        except Exception as ex:
             logger.error(f"Failed all token generation methods: {ex}")

    headers = {
        "Authorization": f"Bearer {id_token_val}"
    }

    # Print Curl command for debugging
    logger.info("--- Curl Command for Debugging ---")
    print(f"curl -v -N -H 'Authorization: Bearer {id_token_val}' {MCP_URL}")
    logger.info("----------------------------------")

    logger.info(f"Headers: Authorization=Bearer ... (len={len(id_token_val)})")

    # Debug: Try plain GET first to check auth validity and capture body
    try:
        logger.info(f"Performing pre-check plain GET to {MCP_URL}...")
        resp = httpx.get(MCP_URL, headers=headers, timeout=10)
        logger.info(f"Pre-check status: {resp.status_code}")
        if resp.status_code != 200:
            logger.error(f"Pre-check failed body: {resp.text}")
            # We can return here if we want, or try SSE anyway
            # If 401/412/403, no point continuing
            return
    except Exception as e:
        logger.error(f"Pre-check failed exception: {e}")

    try:
        async with sse_client(MCP_URL, headers=headers) as (read_stream, write_stream):
            logger.info("✅ Connected to SSE stream!")
            async with ClientSession(read_stream, write_stream) as session:
                logger.info("Initializing session...")
                await session.initialize()
                
                logger.info("Listing tools...")
                tools = await session.list_tools()
                logger.info(f"Tools found: {[t.name for t in tools.tools]}")
                
                logger.info("Calling search_slack_messages...")
                result = await session.call_tool("search_slack_messages", arguments={"query": "hello"})
                logger.info(f"Result: {result.content[0].text[:100]}...")

    except httpx.HTTPStatusError as e:
        logger.error(f"❌ HTTP Error: {e.response.status_code} - {e.response.text}")
        if e.response.status_code == 412:
            print("\n💡 412 Precondition Failed detected.")
            print("Possible causes:")
            print("1. IAP is rejecting the token audience.")
            print("2. 'Expect: 100-continue' header issues.")
    except Exception as e:
        logger.error(f"❌ Error: {e}")
        # Try to print more info if it's an exception group wrapping httpx error
        if hasattr(e, 'exceptions'):
            for ex in e.exceptions:
                if isinstance(ex, httpx.HTTPStatusError):
                     try:
                         # Attempt to read content if possible, mainly for logging
                         await ex.response.aread()
                         logger.error(f"Sub-error HTTP: {ex.response.status_code} - {ex.response.text}")
                     except Exception as read_err:
                         logger.error(f"Sub-error HTTP: {ex.response.status_code} (Could not read body: {read_err})")

if __name__ == "__main__":
    asyncio.run(run_test())

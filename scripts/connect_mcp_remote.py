
import asyncio
import logging
import os
import subprocess
import sys

import httpx
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
    HAS_OAUTHLIB = True
except ImportError:
    HAS_OAUTHLIB = False

# Add shared library to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../python/libs/shared")))


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



async def get_id_token_via_local_flow(client_id, client_secret):
    """Perform a local OAuth flow to get an ID token."""
    if not HAS_OAUTHLIB:
        logger.error("google-auth-oauthlib is not installed. Please run: pip install google-auth-oauthlib")
        return None

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }

    # We need the 'openid' and 'email' scopes to get an ID token
    scopes = ["openid", "https://www.googleapis.com/auth/userinfo.email"]

    try:
        logger.info("Starting local OAuth flow... A browser window should open.")
        flow = InstalledAppFlow.from_client_config(client_config, scopes=scopes)
        # Use a fixed port to make whitelisting in GCP Console easier
        # IMPORTANT: Add http://localhost:8080/ to your OAuth Client Redirect URIs
        creds = flow.run_local_server(port=8080)

        if hasattr(creds, 'id_token'):
            return creds.id_token
        else:
            logger.error("No ID token found in retrieved credentials.")
            return None
    except Exception as e:
        logger.error(f"Error during local OAuth flow: {e}")
        return None

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
        except Exception:
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
        iap_client_secret = mcp_secrets.get("iapClientSecret")
        if not iap_client_id:
            logger.error("❌ 'iapClientId' not found in mcp-config.")
            return

        logger.info(f"Using IAP Client ID: {iap_client_id}")

    except Exception as e:
        logger.error(f"Error fetching secrets: {e}")
        return

    # 2. Generate ID Token
    id_token_val = os.environ.get("IAP_TOKEN")
    user_email = os.environ.get("IAP_USER_EMAIL")

    if id_token_val:
        logger.info("Using IAP_TOKEN from environment.")
    elif user_email:
        logger.info(f"Fetching token for {user_email} from Firestore...")
        try:
            from google.cloud import firestore
            db = firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "PROJECT_ID_PLACEHOLDER"))
            docs = db.collection("AIBot_Google_Tokens").where("email", "==", user_email).stream()
            token_doc = next(docs, None)
            if token_doc:
                id_token_val = token_doc.to_dict().get("id_token")
                logger.info(f"Successfully retrieved token for {user_email} from Firestore.")
            else:
                logger.error(f"❌ No token found in Firestore for {user_email}. Have you signed in at https://aibot.slackapps.atombank.co.uk/auth/login?")
                return
        except Exception as e:
            logger.error(f"❌ Error fetching token from Firestore: {e}")
            return
    else:
        # Try local flow if secrets are available
        if iap_client_id and iap_client_secret:
            logger.info("No token provided. Attempting local 'Log in with Google' flow...")
            id_token_val = await get_id_token_via_local_flow(iap_client_id, iap_client_secret)

        if not id_token_val:
            # Fallback to gcloud check (for information only)
            logger.info("Attempting to generate ID Token via gcloud...")
            try:
                # Note: gcloud auth print-identity-token for USER accounts does NOT support --audiences.
                # It only works for Service Accounts.
                cmd = [
                    "gcloud", "auth", "print-identity-token",
                    f"--audiences={iap_client_id}"
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, check=False)
                if result.returncode == 0:
                    id_token_val = result.stdout.strip()
                    logger.info("Generated ID Token via gcloud.")
                else:
                    logger.warning("gcloud failed to generate token with audience (this is expected for personal accounts).")
                    print("\n💡 TIP: For a real test as a user:")
                    print("   1. Sign in at https://aibot.slackapps.atombank.co.uk/auth/login")
                    print("   2. Run: export IAP_USER_EMAIL=$(gcloud config get-value account) && python scripts/connect_mcp_remote.py\n")
                    print("   Alternatively, the local flow above should have triggered if you have google-auth-oauthlib installed.")
                    return

            except Exception as e:
                logger.error(f"❌ Failed all token generation methods: {e}")
                return

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
        logger.info(f"Performing pre-check plain GET to {MCP_URL} (timeout=30s)...")
        # Increase timeout as LB propagation or cold starts might take time
        resp = httpx.get(MCP_URL, headers=headers, timeout=30)
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

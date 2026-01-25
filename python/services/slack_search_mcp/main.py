import asyncio
import json
import logging
import os
import traceback

from dotenv import load_dotenv
from google import genai
from google.cloud import bigquery
from google.genai import types
from mcp.server.fastmcp import FastMCP
from shared.gcp_api import get_secret_value
from shared.google_auth import verify_iap_jwt

# Import from shared library submodules
from shared.logging import setup_logging
from shared.security import is_team_authorized
from shared.slack_api import create_client_for_token
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

load_dotenv()
setup_logging()
logger = logging.getLogger("slack-search-mcp")

GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
GCP_LOCATION = os.environ.get("GCP_LOCATION")
if not GCP_LOCATION:
    raise OSError(
        "GCP_LOCATION environment variable is required and must be set explicitly."
    )

# Initialize Google Gen AI Client
genai_client = genai.Client(
    vertexai=True, project=GOOGLE_CLOUD_PROJECT, location=GCP_LOCATION
)

# --- Middleware: Security Verification ---


class SecurityMiddleware(BaseHTTPMiddleware):
    """
    Starlette middleware for MCP SSE backend to verify access.
    Supports both:
    1. Bearer Token (Directly provided Slack token)
    2. IAP (Google Identity mapping to Slack ID/Token)
    """

    async def dispatch(self, request, call_next):
        logger.info(f"SecurityMiddleware START: {request.method} {request.url.path}")
        if request.url.path == "/health":
            return await call_next(request)

        # 0. Bypass for testing
        if os.environ.get("ENV") == "test":
            return await call_next(request)

        # 1. Whitelist Verification
        if request.url.path not in ["/mcp/sse", "/mcp/messages", "/mcp/messages/"]:
            logger.warning(
                f"Stealth security: Unauthorized access attempt to {request.url.path} from {request.client.host}"
            )
            return JSONResponse({"error": "Forbidden"}, status_code=403)

        # 2. Extract and Verify IAP JWT Assertion
        iap_jwt = request.headers.get("X-Goog-IAP-JWT-Assertion")
        if not iap_jwt:
            logger.warning("Missing X-Goog-IAP-JWT-Assertion header")
            return JSONResponse(
                {"error": "Authentication required (IAP)"}, status_code=401
            )

        iap_audience = await get_secret_value("iapAudience")
        payload = await verify_iap_jwt(iap_jwt, expected_audience=iap_audience)
        if not payload:
            logger.error(f"IAP JWT Verification failed for audience: {iap_audience}")
            return JSONResponse({"error": "Invalid IAP Assertion"}, status_code=403)

        email = payload.get("email")
        if not email:
            logger.error(
                f"IAP JWT payload missing 'email' claim. Payload keys: {list(payload.keys())}"
            )
            return JSONResponse(
                {"error": "Email missing from identity"}, status_code=403
            )

        # 3. Verify Slack Membership using Bot Token
        try:
            bot_token = await get_secret_value("slackBotToken")
            slack_client = WebClient(token=bot_token)

            loop = asyncio.get_event_loop()
            slack_user_resp = await loop.run_in_executor(
                None, lambda: slack_client.users_lookupByEmail(email=email)
            )

            if not slack_user_resp.get("ok"):
                logger.warning(
                    f"User {email} not found in Slack: {slack_user_resp.get('error')}"
                )
                return JSONResponse(
                    {"error": "User not recognized in Slack workspace"}, status_code=403
                )

            # 4. Check team ID matches whitelist
            user_info = slack_user_resp.get("user", {})
            team_id = user_info.get("team_id")
            enterprise_id = user_info.get("enterprise_id")

            logger.info(
                f"Checking authorization for user {email}: team={team_id}, enterprise={enterprise_id}"
            )
            logger.debug(f"Full Slack user info: {json.dumps(user_info)}")

            if not await is_team_authorized(team_id, enterprise_id=enterprise_id):
                logger.warning(
                    f"User {email} belongs to unauthorized team {team_id} or enterprise {enterprise_id}"
                )
                return JSONResponse(
                    {"error": "Workspace not authorized"}, status_code=403
                )

        except Exception:
            logger.exception(f"Internal security validation error for {email}")
            return JSONResponse(
                {"error": "Security validation failed"}, status_code=500
            )

        # 5. Success - Proceed with request
        response = await call_next(request)
        logger.debug(
            f"SecurityMiddleware FINISHED for {email} with status {response.status_code}"
        )
        return response


# --- Service Logic ---
custom_fqdn = os.environ.get("CUSTOM_FQDN", "aibot.slackapps.atombank.co.uk")
logger.info(f"Initializing FastMCP with host: {custom_fqdn}")

# Initialize FastMCP with explicit paths to match LB routing
# sse_path and message_path control the Starlette routes.
# mount_path defaults to "/" and is used for constructing the callback URL.
# We set host to our FQDN to satisfy zero-trust requirements while allowing LB traffic.
mcp = FastMCP(
    "slack-search-server",
    sse_path="/mcp/sse",
    message_path="/mcp/messages/",
    mount_path="/",
    host=custom_fqdn,
)


@mcp.tool()
async def search_slack_messages(query: str) -> str:
    """Search Slack messages using vector search and return thread context."""
    logger.info(f"TOOL START: search_slack_messages for query: {query}")
    # Use User Token for fetching thread context to avoid 'not_in_channel' error.
    token = await get_secret_value("slackUserToken")

    if not token:
        return "No Slack token found."

    try:
        slack_client = await create_client_for_token(token)
        # 1. Generate Embeddings
        embeddings = await generate_embeddings(query)

        # 2. Perform Vector Search in BigQuery
        results = await perform_vector_search(embeddings)

        # 3. Fetch Workspace Info for Deep Links
        team_resp = await slack_client.team_info()
        if not team_resp.get("ok"):
            raise Exception(
                f"Failed to fetch Slack team info: {team_resp.get('error')}. Ensure 'team:read' User scope is granted."
            )

        team_domain = team_resp.get("team", {}).get("domain")
        team_id = team_resp.get("team", {}).get("id")
        if not team_domain:
            raise Exception(
                "Slack team info returned successfully but 'domain' is missing."
            )

        # 4. Fetch Threads from Slack in Parallel
        async def fetch_thread(row):
            try:
                resp = await slack_client.conversations_replies(
                    channel=row["channel"], ts=str(row["ts"]), inclusive=True
                )
                if resp.get("ok"):
                    thread_messages = []
                    for msg in resp.get("messages", []):
                        ts_str = msg.get("ts", "")
                        ts_digits = ts_str.replace(".", "")
                        url = f"https://{team_domain}.slack.com/archives/{row['channel']}/p{ts_digits}"
                        if msg.get("thread_ts") and msg.get("thread_ts") != ts_str:
                            url += f"?thread_ts={msg.get('thread_ts')}&cid={row['channel']}"

                        thread_messages.append(
                            {
                                "text": msg.get("text"),
                                "team_id": team_id,
                                "channel_id": row["channel"],
                                "ts": ts_str,
                                "user_id": msg.get("user"),
                                "url": url,
                                "thread_ts": msg.get("thread_ts"),
                            }
                        )
                    return thread_messages
            except SlackApiError as e:
                logger.warning(
                    f"Slack API warning fetching thread {row['ts']} in {row['channel']}: {e.response['error']}"
                )
            except Exception as e:
                logger.warning(
                    f"Unexpected error fetching thread {row['ts']} in {row['channel']}: {e}"
                )
            return []

        thread_results = await asyncio.gather(*[fetch_thread(row) for row in results])
        messages = [msg for thread in thread_results for msg in thread]

        return json.dumps(messages, indent=2)

    except Exception as e:
        logger.exception(f"Error during search_slack_messages for query: {query}")
        return f"Error during search: {str(e)}"


async def generate_embeddings(text: str) -> list[float]:
    """Generate text embeddings using the new google-genai SDK."""
    response = await genai_client.aio.models.embed_content(
        model="text-embedding-004",
        contents=text,
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    return response.embeddings[0].values


async def perform_vector_search(embeddings: list[float]):
    client = bigquery.Client(project=GOOGLE_CLOUD_PROJECT)
    query = f"""
        SELECT distinct base.channel, base.ts, distance
        FROM VECTOR_SEARCH(
            TABLE aibot_slack_messages.slack_content,
            'embeddings',
            (SELECT {embeddings} as search_embeddings),
            query_column_to_search => 'search_embeddings',
            top_k => 15
        )
        ORDER BY distance
    """
    loop = asyncio.get_event_loop()
    query_job = await loop.run_in_executor(None, client.query, query)
    rows = await loop.run_in_executor(None, query_job.result)
    return [dict(row) for row in rows]


# FastMCP provides an SSE app (Starlette based)
app = mcp.sse_app()


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(
        "Unhandled exception in slack-search-mcp",
        extra={
            "path": request.url.path,
            "method": request.method,
            "exception": str(exc),
            "traceback": traceback.format_exc(),
        },
    )
    return JSONResponse(
        status_code=500, content={"message": f"Internal Server Error: {str(exc)}"}
    )


# Add the security middleware (last added = first executed)
app.add_middleware(SecurityMiddleware)

# Log registered routes for debugging 404s (Runs on import)
logger.info("DEBUG: Registering Routes during Import:")
for route in app.routes:
    # Use getattr to safely access path/methods if they exist
    path = getattr(route, "path", str(route))
    methods = getattr(route, "methods", "N/A")
    name = getattr(route, "name", "N/A")
    logger.info(f" - {path} [methods={methods}] ({route.__class__.__name__})")

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

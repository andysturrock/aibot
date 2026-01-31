import asyncio
import json
import logging
import os
import traceback
import uuid
from contextvars import ContextVar

from dotenv import load_dotenv
from google import genai
from google.cloud import bigquery
from google.cloud.bigquery import ArrayQueryParameter, QueryJobConfig
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

# Context variable to store current user's Slack ID for tool filtering
user_id_ctx: ContextVar[str] = ContextVar("user_id", default=None)
team_id_ctx: ContextVar[str] = ContextVar("team_id", default=None)


# --- Middleware: Security Verification ---


class SecurityMiddleware:
    """
    ASGI middleware for MCP SSE backend to verify access.
    Avoids BaseHTTPMiddleware to prevent issues with streaming responses (SSE).
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        path = request.url.path

        if path == "/health":
            await self.app(scope, receive, send)
            return

        try:
            # 1. Whitelist Verification
            if path not in ["/mcp/sse", "/mcp/messages", "/mcp/messages/"]:
                logger.warning(
                    f"Stealth security: Unauthorized access attempt to {path} from {request.client.host}"
                )
                response = JSONResponse({"error": "Forbidden"}, status_code=403)
                await response(scope, receive, send)
                return
            # 2. Extract and Verify IAP JWT Assertion
            iap_jwt = request.headers.get("X-Goog-IAP-JWT-Assertion")
            if not iap_jwt:
                logger.warning("Missing X-Goog-IAP-JWT-Assertion header")
                response = JSONResponse(
                    {"error": "Authentication required (IAP)"}, status_code=401
                )
                await response(scope, receive, send)
                return

            iap_audience = await get_secret_value("iapAudience")
            payload = await verify_iap_jwt(iap_jwt, expected_audience=iap_audience)
            if not payload:
                logger.error(
                    f"IAP JWT Verification failed for audience: {iap_audience}"
                )
                response = JSONResponse(
                    {"error": "Invalid IAP Assertion"}, status_code=403
                )
                await response(scope, receive, send)
                return

            email = payload.get("email")
            if not email:
                logger.error(
                    f"IAP JWT payload missing 'email' claim. Payload keys: {list(payload.keys())}"
                )
                response = JSONResponse(
                    {"error": "Email missing from identity"}, status_code=403
                )
                await response(scope, receive, send)
                return

            # 3. Verify Slack Membership using Bot Token
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
                response = JSONResponse(
                    {"error": "User not recognized in Slack workspace"}, status_code=403
                )
                await response(scope, receive, send)
                return

            # 4. Check team ID matches whitelist
            user_info = slack_user_resp.get("user", {})
            slack_user_id = user_info.get("id")
            team_id = user_info.get("team_id")
            enterprise_id = user_info.get("enterprise_id")

            # Fallback for Enterprise Grid where team_id might be inside enterprise_user
            if not team_id and "enterprise_user" in user_info:
                ent_user = user_info["enterprise_user"]
                teams = ent_user.get("teams", [])
                if teams:
                    team_id = teams[0]
                    logger.info(
                        f"Extracted team_id from enterprise_user.teams: {team_id}"
                    )

            logger.info(
                f"Authorizing user {email}: slack_id={slack_user_id}, team={team_id}, enterprise={enterprise_id}"
            )

            if not await is_team_authorized(team_id, enterprise_id=enterprise_id):
                logger.warning(
                    f"User {email} belongs to unauthorized team {team_id} or enterprise {enterprise_id}"
                )
                response = JSONResponse(
                    {"error": "Workspace not authorized"}, status_code=403
                )
                await response(scope, receive, send)
                return

            # 5. Success - Set user ID in context and proceed
            token = user_id_ctx.set(slack_user_id)
            team_token = team_id_ctx.set(team_id)
            try:
                await self.app(scope, receive, send)
            finally:
                user_id_ctx.reset(token)
                team_id_ctx.reset(team_token)

            logger.debug(f"SecurityMiddleware FINISHED for {email}")

        except Exception:
            logger.exception("Internal security validation error during auth check")
            response = JSONResponse(
                {"error": "Security validation failed"}, status_code=500
            )
            await response(scope, receive, send)
            return


# --- Service Logic ---
custom_fqdn = os.environ.get("CUSTOM_FQDN", "aibot.example.com")
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

        # 1. Fetch User's Permitted Channels (Security Check)
        # We fetch the user's current channel memberships in real-time. This ensures that
        # if a channel was public but is now private (and the user is not a member),
        # or if a user was removed from a group, they will not see results from that channel.
        user_id = user_id_ctx.get()
        team_id = team_id_ctx.get()
        logger.info(f"Using context: user_id={user_id}, team_id={team_id}")

        if not user_id:
            logger.error("No user_id found in contextvars for search request")
            return "Unauthorized lookup"

        permitted_channels = set()
        try:
            # Note: types can include public_channel, private_channel
            # We use an admin/shared token to see which channels THIS user is in.
            cursor = None
            while True:
                user_convs = await slack_client.users_conversations(
                    user=user_id,
                    types="public_channel,private_channel",
                    cursor=cursor,
                    limit=1000,
                    team_id=team_id,
                )
                if not user_convs.get("ok"):
                    logger.error(
                        f"Failed to fetch user conversations: {user_convs.get('error')}"
                    )
                    break

                for channel in user_convs.get("channels", []):
                    permitted_channels.add(channel["id"])

                cursor = user_convs.get("response_metadata", {}).get("next_cursor")
                if not cursor:
                    break
            logger.info(
                f"User {user_id} is member of {len(permitted_channels)} channels"
            )
        except Exception as e:
            logger.error(f"Error checking user permissions: {str(e)}")
            return "Error validating permissions"

        # 2. Generate Embeddings
        embeddings = await generate_embeddings(query)

        # 3. Perform Vector Search in BigQuery
        results = await perform_vector_search(embeddings)

        # 4. Filter Results by Permissions
        filtered_results = [
            row for row in results if row["channel"] in permitted_channels
        ]
        logger.info(
            f"Filtered {len(results)} results down to {len(filtered_results)} for user {user_id}"
        )

        if not filtered_results:
            return "No messages found in your authorized channels."

        # 5. Fetch Workspace Info for Deep Links
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

        thread_results = await asyncio.gather(
            *[fetch_thread(row) for row in filtered_results]
        )
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
    query = """
        SELECT distinct base.channel, base.ts, distance
        FROM VECTOR_SEARCH(
            TABLE aibot_slack_messages.slack_content,
            'embeddings',
            (SELECT @query_embeddings as search_embeddings),
            query_column_to_search => 'search_embeddings',
            top_k => 15
        )
        ORDER BY distance
    """
    job_config = QueryJobConfig(
        query_parameters=[
            ArrayQueryParameter("query_embeddings", "FLOAT64", embeddings),
        ]
    )
    loop = asyncio.get_event_loop()
    query_job = await loop.run_in_executor(
        None, lambda: client.query(query, job_config=job_config)
    )
    rows = await loop.run_in_executor(None, query_job.result)
    return [dict(row) for row in rows]


# FastMCP provides an SSE app (Starlette based)
app = mcp.sse_app()


async def global_exception_handler(request: Request, exc: Exception):
    request_id = str(uuid.uuid4())
    logger.error(
        f"Unhandled exception in slack-search-mcp [Request ID: {request_id}]",
        extra={
            "request_id": request_id,
            "path": request.url.path,
            "method": request.method,
            "exception": str(exc),
            "traceback": traceback.format_exc(),
        },
    )
    return JSONResponse(
        status_code=500,
        content={"message": "Internal Server Error", "request_id": request_id},
    )


async def health(request: Request):
    return JSONResponse({"status": "ok"})


app.add_route("/health", health)

# Add exception handler explicitly to avoid deprecation warnings
app.add_exception_handler(Exception, global_exception_handler)

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

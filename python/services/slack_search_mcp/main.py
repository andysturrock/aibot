import asyncio
import json
import logging
import os
import time
import traceback
import uuid
from contextvars import ContextVar

from dotenv import load_dotenv
from google import genai
from google.cloud import bigquery
from google.cloud.bigquery import ArrayQueryParameter, QueryJobConfig
from google.genai import types
from mcp.server.fastmcp import FastMCP
from shared.firestore_api import AIBOT_DB
from shared.gcp_api import get_secret_value
from shared.google_auth import verify_iap_jwt

# Import from shared library submodules
from shared.logging import setup_logging
from shared.security import is_user_authorized
from shared.slack_api import create_client_for_token
from slack_sdk import WebClient
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


# Rate limiting constants for impersonation

IMPERSONATION_WINDOW_SECONDS = 60
MAX_UNIQUE_IMPERSONATIONS = 20
IMPERSONATION_DB = AIBOT_DB
IMPERSONATION_LOG_COLLECTION = "AIBot_Impersonation_Logs"


class SecurityMiddleware:
    """
    ASGI middleware for MCP SSE backend to verify access.
    Avoids BaseHTTPMiddleware to prevent issues with streaming responses (SSE).
    """

    def __init__(self, app):
        self.app = app

    async def _check_impersonation_rate_limit(self, user_email: str) -> bool:
        """
        Tracks unique users impersonated in the last 60 seconds across all instances.
        Returns True if allowed, False if limit exceeded.
        """
        from google.cloud import firestore

        db = firestore.AsyncClient(database=IMPERSONATION_DB)
        now = time.time()
        cutoff = now - IMPERSONATION_WINDOW_SECONDS

        # 1. Log this impersonation attempt
        # Use a unique ID to avoid collisions, but include user and timestamp
        doc_id = f"{int(now * 1000)}_{user_email}"
        await (
            db.collection(IMPERSONATION_LOG_COLLECTION)
            .document(doc_id)
            .set(
                {
                    "user_email": user_email,
                    "timestamp": now,
                    "expiry": now + 3600,  # TTL for cleanup if needed
                }
            )
        )

        # 2. Query unique users in the window
        # Firestore doesn't have a native "SELECT COUNT(DISTINCT ...)"
        # For small limits (20), we can just fetch and count in memory.
        query = (
            db.collection(IMPERSONATION_LOG_COLLECTION)
            .where("timestamp", ">=", cutoff)
            .stream()
        )

        unique_users = set()
        async for doc in query:
            unique_users.add(doc.to_dict().get("user_email"))

        logger.info(
            f"Global Impersonation Check: {len(unique_users)}/{MAX_UNIQUE_IMPERSONATIONS} unique users in last {IMPERSONATION_WINDOW_SECONDS}s"
        )
        return len(unique_users) <= MAX_UNIQUE_IMPERSONATIONS

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        path = request.url.path

        if path == "/health" or path == "/healthz":
            response = JSONResponse({"status": "ok"}, status_code=200)
            await response(scope, receive, send)
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
            iap_payload = await verify_iap_jwt(iap_jwt, expected_audience=iap_audience)
            if not iap_payload:
                logger.error(
                    f"IAP JWT Verification failed for audience: {iap_audience}"
                )
                response = JSONResponse(
                    {"error": "Invalid IAP Assertion"}, status_code=403
                )
                await response(scope, receive, send)
                return

            caller_email = iap_payload.get("email")
            if not caller_email:
                response = JSONResponse(
                    {"error": "Email missing from identity"}, status_code=403
                )
                await response(scope, receive, send)
                return

            # 3. Determine User Identity
            final_user_email = caller_email
            is_logic_server = "aibot-logic" in caller_email

            if is_logic_server:
                # Require X-User-ID-Token for impersonation
                user_id_token = request.headers.get("X-User-ID-Token")
                if not user_id_token:
                    logger.warning("Logic Server calling without X-User-ID-Token")
                    response = JSONResponse(
                        {"error": "X-User-ID-Token required for Logic Server"},
                        status_code=401,
                    )
                    await response(scope, receive, send)
                    return

                # Verify User ID Token
                from google.auth.transport import requests as auth_requests
                from google.oauth2 import id_token as google_id_token

                try:
                    # The audience for these user tokens is the IAP Client ID.
                    client_id = await get_secret_value("iapClientId")
                    user_payload = google_id_token.verify_oauth2_token(
                        user_id_token, auth_requests.Request(), client_id
                    )
                    final_user_email = user_payload.get("email")
                    if not final_user_email:
                        raise ValueError("User ID Token missing email")

                    # Rate Limit Impersonation
                    if not await self._check_impersonation_rate_limit(final_user_email):
                        logger.warning(
                            f"Rate limit exceeded: Logic Server impersonating too many unique users ({final_user_email})"
                        )
                        response = JSONResponse(
                            {"error": "Impersonation rate limit exceeded"},
                            status_code=429,
                        )
                        await response(scope, receive, send)
                        return

                    # Scrub X-User-ID-Token from headers before passing to downstream logic
                    # Headers in ASGI scope are a list of (name, value) byte tuples
                    scope["headers"] = [
                        (k, v)
                        for k, v in scope["headers"]
                        if k.lower() != b"x-user-id-token"
                    ]

                except Exception as e:
                    logger.error(f"User ID Token verification failed: {e}")
                    response = JSONResponse(
                        {"error": f"Invalid User ID Token: {str(e)}"},
                        status_code=403,
                    )
                    await response(scope, receive, send)
                    return

            # 4. Verify Slack Membership using Bot Token
            bot_token = await get_secret_value("slackBotToken")
            slack_client = WebClient(token=bot_token)

            loop = asyncio.get_event_loop()
            slack_user_resp = await loop.run_in_executor(
                None,
                lambda: slack_client.users_lookupByEmail(email=final_user_email),
            )

            if not slack_user_resp.get("ok"):
                logger.warning(
                    f"User {final_user_email} not found in Slack: {slack_user_resp.get('error')}"
                )
                response = JSONResponse(
                    {"error": "User not recognized in Slack workspace"},
                    status_code=403,
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
                f"Authorizing user {final_user_email}: slack_id={slack_user_id}, team={team_id}, enterprise={enterprise_id}"
            )

            if not await is_user_authorized(
                final_user_email, team_id, enterprise_id=enterprise_id
            ):
                logger.warning(
                    f"User {final_user_email} failed authorization check (Domain/Team: {team_id}/{enterprise_id})"
                )
                response = JSONResponse(
                    {"error": "Unauthorized access (Email Domain or Slack Workspace)"},
                    status_code=403,
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

            logger.debug(f"SecurityMiddleware FINISHED for {final_user_email}")

        except Exception:
            logger.exception("Internal security validation error during auth check")
            response = JSONResponse(
                {"error": "Security validation failed"}, status_code=500
            )
            await response(scope, receive, send)
            return


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


class GlobalCache:
    """Simple in-memory cache with TTL for Cloud Run instance re-use."""

    def __init__(self):
        self._user_names = {}  # user_id -> (name, expiry)
        self._channel_info = {}  # channel_id -> (data, expiry)

    def get_user_name(self, user_id):
        if user_id in self._user_names:
            name, expiry = self._user_names[user_id]
            if time.time() < expiry:
                return name
        return None

    def set_user_name(self, user_id, name, ttl=3600):
        self._user_names[user_id] = (name, time.time() + ttl)

    def get_channel_info(self, channel_id):
        if channel_id in self._channel_info:
            data, expiry = self._channel_info[channel_id]
            if time.time() < expiry:
                return data
        return None

    def set_channel_info(self, channel_id, data, ttl=600):
        self._channel_info[channel_id] = (data, time.time() + ttl)


cache = GlobalCache()


@mcp.tool()
async def search_slack_messages(query: str) -> str:
    """Search Slack messages using vector search and return thread context."""
    logger.info(f"TOOL START: search_slack_messages for query: {query}")
    token = await get_secret_value("slackUserToken")

    if not token:
        return "No Slack token found."

    try:
        slack_client = await create_client_for_token(token)

        # 1. Generate Embeddings for search
        embeddings = await generate_embeddings(query)

        # 2. Perform Vector Search in BigQuery
        results = await perform_vector_search(embeddings)
        if not results:
            return "No messages found."

        # 3. Reactive Permission Check & Metadata Fetching
        permitted_channels = {}  # channel_id -> channel_info (name, is_permitted)

        async def check_channel_access(channel_id):
            cached = cache.get_channel_info(channel_id)
            if cached:
                permitted_channels[channel_id] = cached
                return cached

            try:
                info = await slack_client.conversations_info(channel=channel_id)
                if not info.get("ok"):
                    res = {"permitted": False}
                else:
                    channel = info.get("channel", {})
                    is_private = channel.get("is_private", False)
                    is_member = channel.get("is_member", False)
                    name = channel.get("name", "unknown-channel")
                    res = {"permitted": not is_private or is_member, "name": name}

                cache.set_channel_info(channel_id, res)
                permitted_channels[channel_id] = res
                return res
            except Exception as e:
                logger.error(f"Error checking access for {channel_id}: {str(e)}")
                return {"permitted": False}

        unique_channels = list(set(row["channel"] for row in results))
        await asyncio.gather(*[check_channel_access(cid) for cid in unique_channels])

        # 4. Filter Results
        filtered_results = [
            row
            for row in results
            if permitted_channels.get(row["channel"], {}).get("permitted")
        ]

        if not filtered_results:
            return "No messages found in your authorized channels."

        # 5. Fetch Workspace Info for Deep Links
        team_resp = await slack_client.team_info()
        if not team_resp.get("ok"):
            raise Exception(
                f"Failed to fetch Slack team info: {team_resp.get('error')}"
            )

        team_domain = team_resp.get("team", {}).get("domain")
        team_id = team_id_ctx.get() or team_resp.get("team", {}).get("id")

        # 6. Fetch Threads from Slack in Parallel
        async def fetch_thread_messages(row):
            try:
                resp = await slack_client.conversations_replies(
                    channel=row["channel"], ts=str(row["ts"]), inclusive=True
                )
                if resp.get("ok"):
                    return row["channel"], resp.get("messages", [])
            except Exception as e:
                logger.warning(f"Error fetching thread {row['ts']}: {e}")
            return row["channel"], []

        thread_data = await asyncio.gather(
            *[fetch_thread_messages(row) for row in filtered_results]
        )

        # 7. Collect all unique user IDs for batch fetching
        all_user_ids = set()
        for _, thread_msgs in thread_data:
            for msg in thread_msgs:
                if msg.get("user"):
                    all_user_ids.add(msg["user"])

        # 8. Batch Fetch User Names
        async def fetch_user_name(user_id):
            cached_name = cache.get_user_name(user_id)
            if cached_name:
                return user_id, cached_name

            try:
                u_resp = await slack_client.users_info(user=user_id)
                if u_resp.get("ok"):
                    user_name = (
                        u_resp.get("user", {}).get("real_name")
                        or u_resp.get("user", {}).get("name")
                        or user_id
                    )
                    cache.set_user_name(user_id, user_name)
                    return user_id, user_name
            except Exception:
                pass
            return user_id, "unknown-user"

        user_names_list = await asyncio.gather(
            *[fetch_user_name(uid) for uid in all_user_ids]
        )
        user_map = dict(user_names_list)

        # 9. Format Final Result
        final_messages = []
        for channel_id, thread_msgs in thread_data:
            channel_name = permitted_channels.get(channel_id, {}).get(
                "name", "unknown-channel"
            )
            for msg in thread_msgs:
                ts_str = msg.get("ts", "")
                ts_digits = ts_str.replace(".", "")
                url = f"https://{team_domain}.slack.com/archives/{channel_id}/p{ts_digits}"
                if msg.get("thread_ts") and msg.get("thread_ts") != ts_str:
                    url += f"?thread_ts={msg.get('thread_ts')}&cid={channel_id}"

                final_messages.append(
                    {
                        "text": msg.get("text"),
                        "team_id": team_id,
                        "channel_id": channel_id,
                        "channel_name": channel_name,
                        "ts": ts_str,
                        "user_id": msg.get("user"),
                        "user_name": user_map.get(msg.get("user"), "unknown-user"),
                        "url": url,
                        "thread_ts": msg.get("thread_ts"),
                    }
                )

        logger.info(f"Returning {len(final_messages)} messages to agent")
        return json.dumps(final_messages, indent=2)

    except Exception as e:
        logger.exception("Error during search_slack_messages")
        return f"Error during search: {str(e)}"

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
logger.debug("Registering Routes during Import:")
for route in app.routes:
    # Use getattr to safely access path/methods if they exist
    path = getattr(route, "path", str(route))
    methods = getattr(route, "methods", "N/A")
    name = getattr(route, "name", "N/A")
    logger.debug(f" - {path} [methods={methods}] ({route.__class__.__name__})")

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

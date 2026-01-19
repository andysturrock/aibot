import os
import json
import logging
import asyncio
import sys
import subprocess
import traceback
from typing import List, Dict, Any, Optional
from contextvars import ContextVar

from mcp.server.fastmcp import FastMCP
from google.cloud import bigquery
from vertexai.language_models import TextEmbeddingInput, TextEmbeddingModel
from dotenv import load_dotenv
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.requests import Request
import vertexai

# Import from shared library submodules
from shared.logging import setup_logging
from shared.gcp_api import get_secret_value
from shared.slack_api import create_client_for_token
from shared.security import is_team_authorized

load_dotenv()
setup_logging()
logger = logging.getLogger("slack-search-mcp")

GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
GCP_LOCATION = os.environ.get("GCP_LOCATION")
if not GCP_LOCATION:
    raise EnvironmentError("GCP_LOCATION environment variable is required and must be set explicitly.")

vertexai.init(project=GOOGLE_CLOUD_PROJECT, location=GCP_LOCATION)

# ContextVar to store the current request's Slack token
slack_token_var: ContextVar[Optional[str]] = ContextVar("slack_token", default=None)

# --- Middleware: Security Verification ---

class SecurityMiddleware(BaseHTTPMiddleware):
    """
    Starlette middleware for MCP SSE backend to verify access.
    Supports both:
    1. Bearer Token (Directly provided Slack token)
    2. IAP (Google Identity mapping to Slack ID/Token)
    """
    async def dispatch(self, request, call_next):
        logger.info(f"DEBUG: Middleware received request: {request.method} {request.url.path}")
        if request.url.path == "/health":
            return await call_next(request)

        # Updated whitelist to match FastMCP's default paths (no /mcp prefix)
        if request.url.path not in ["/sse", "/messages", "/messages/"]:
            logger.warning(f"Stealth security: Unauthorized access attempt to {request.url.path} from {request.client.host}")
            return JSONResponse({"error": "Forbidden"}, status_code=403)

        from shared.security import get_iap_user_email
        from shared.firestore_api import get_slack_id_by_email, get_access_token
        
        token = None
        
        # 1. Check for IAP Identity
        email = await get_iap_user_email(dict(request.headers))
        if email:
            logger.info(f"Authenticating IAP user: {email}")
            slack_id = await get_slack_id_by_email(email)
            if slack_id:
                token = await get_access_token(slack_id)
            else:
                logger.warning(f"No Slack ID found for email: {email}. Falling back to explicit token check.")
                pass

        # 2. Fallback to Bearer Token or X-Slack-Token (if no IAP or IAP lookup failed)
        if not token:
            token = request.headers.get("X-Slack-Token")
            
            if not token:
                auth_header = request.headers.get("Authorization")
                if auth_header and auth_header.startswith("Bearer "):
                    token = auth_header.split(" ")[1]

        # 3. Validation & Team Check
        if token:
            try:
                slack_client = await create_client_for_token(token)
                auth_test = await slack_client.auth_test()
                
                team_id = auth_test.get("team_id")
                enterprise_id = auth_test.get("enterprise_id")
                
                if not await is_team_authorized(team_id, enterprise_id):
                    logger.warning(f"Unauthorized team access attempt: {team_id}")
                    return JSONResponse({"error": "Unauthorized workspace"}, status_code=403)
                
                # Set the token in our context var for tools to use
                token_token = slack_token_var.set(token)
                try:
                    response = await call_next(request)
                    logger.debug(f"Path {request.url.path} returned {response.status_code}")
                    return response
                finally:
                    slack_token_var.reset(token_token)
                    
            except Exception as e:
                logger.error(f"Inbound verification failed for {request.url.path}", extra={
                    "path": request.url.path,
                    "exception": str(e)
                }, exc_info=True)
                return JSONResponse({"error": "Invalid authentication token"}, status_code=401)
        else:
            return JSONResponse({"error": "Authentication required"}, status_code=401)

# --- Service Logic ---

# Initialize FastMCP
mcp = FastMCP("slack-search-server")

@mcp.tool()
async def search_slack_messages(query: str) -> str:
    """Search Slack messages using vector search and return thread context."""
    # 1. Get token from context (set by middleware) or fallback to env
    token = slack_token_var.get() or os.environ.get("SLACK_USER_TOKEN") or await get_secret_value("slackUserToken")

    if not token:
        return "No Slack token found."

    try:
        slack_client = await create_client_for_token(token)
        # 1. Generate Embeddings
        embeddings = await generate_embeddings(query)
        
        # 2. Perform Vector Search in BigQuery
        results = await perform_vector_search(embeddings)
        
        # 3. Fetch Threads from Slack
        messages = []
        for row in results:
            try:
                resp = await slack_client.conversations_replies(
                    channel=row['channel'],
                    ts=str(row['ts']),
                    inclusive=True
                )
                if resp.get("ok"):
                    for msg in resp.get("messages", []):
                        messages.append({
                            "channel": row['channel'],
                            "user": msg.get("user"),
                            "text": msg.get("text"),
                            "ts": msg.get("ts"),
                            "thread_ts": msg.get("thread_ts")
                        })
            except Exception as e:
                logger.error(f"Error fetching thread {row['ts']} in {row['channel']}: {e}")

        return json.dumps(messages, indent=2)

    except Exception as e:
        logger.exception("Error during search")
        return f"Error during search: {str(e)}"

async def generate_embeddings(text: str) -> List[float]:
    model = TextEmbeddingModel.from_pretrained("text-embedding-004")
    inputs = [TextEmbeddingInput(text, "RETRIEVAL_QUERY")]
    embeddings = await model.get_embeddings_async(inputs)
    return embeddings[0].values

async def perform_vector_search(embeddings: List[float]):
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
# Removing mount_path="/mcp" so it defaults to "/"
app = mcp.sse_app()

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception in slack-search-mcp", extra={
        "path": request.url.path,
        "method": request.method,
        "exception": str(exc),
        "traceback": traceback.format_exc()
    })
    return JSONResponse(
        status_code=500,
        content={"message": f"Internal Server Error: {str(exc)}"}
    )

# Add the security middleware
app.add_middleware(SecurityMiddleware)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

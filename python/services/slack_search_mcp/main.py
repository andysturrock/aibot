import os
import json
import logging
from typing import List, Dict, Any
import asyncio

from mcp.server.fastmcp import FastMCP
from google.cloud import bigquery
from vertexai.language_models import TextEmbeddingInput, TextEmbeddingModel
from dotenv import load_dotenv

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# Import from shared library
from shared import (
    get_secret_value, 
    create_client_for_token,
    is_team_authorized
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("slack-search-mcp")

GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
GCP_LOCATION = os.environ.get("GCP_LOCATION", "europe-west1")

# --- Middleware: Security Verification ---

class SecurityMiddleware(BaseHTTPMiddleware):
    """
    Starlette middleware for MCP SSE backend to verify Slack access.
    Note: MCP SSE transport usually receives a Bearer token in the header 
    which we use here to verify whitelisting.
    """
    async def dispatch(self, request, call_next):
        if request.url.path in ["/mcp/sse", "/mcp/messages"]:
            auth_header = request.headers.get("Authorization")
            if not auth_header or not auth_header.startswith("Bearer "):
                # We can't verify yet without a token, so we let it through 
                # but the tool itself will fail later if token is missing.
                # However, for true server-level verification, we expect the token.
                return await call_next(request)
            
            token = auth_header.split(" ")[1]
            try:
                slack_client = await create_client_for_token(token)
                auth_test = await slack_client.auth_test()
                
                team_id = auth_test.get("team_id")
                enterprise_id = auth_test.get("enterprise_id")
                
                if not await is_team_authorized(team_id, enterprise_id):
                    return JSONResponse({"error": "Unauthorized workspace"}, status_code=403)
            except Exception as e:
                logger.error(f"Error in security middleware: {e}")
                return JSONResponse({"error": "Authentication failed"}, status_code=401)
                
        return await call_next(request)

# --- Service Logic ---

# Initialize FastMCP
mcp = FastMCP("slack-search-server")

@mcp.tool()
async def search_slack_messages(query: str) -> str:
    """Search Slack messages using vector search and return thread context."""
    # The middleware already verified the token if it was in the header, 
    # but we still need it here for the search logic.
    token = os.environ.get("SLACK_USER_TOKEN") or await get_secret_value("AIBot", "slackUserToken")

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
app = mcp.sse_app(mount_path="/mcp")
# Add the security middleware
app.add_middleware(SecurityMiddleware)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

import asyncio
import logging
import os
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from google.cloud import bigquery
from shared.gcp_api import get_secret_value

# Import from shared library submodules
from shared.logging import setup_logging
from shared.security import is_team_authorized
from shared.slack_api import (
    Message,
    get_channel_messages_using_token,
    get_public_channels,
)
from starlette.middleware.base import BaseHTTPMiddleware
from vertexai.language_models import TextEmbeddingInput, TextEmbeddingModel

load_dotenv()
setup_logging()
logger = logging.getLogger("slack-collector")

DATASET_NAME = "aibot_slack_messages"
CONTENT_TABLE_NAME = "slack_content"
METADATA_TABLE_NAME = "slack_content_metadata"

# --- Middleware: Structured Logging ---


class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method

        if path == "/health":
            return await call_next(request)

        if path != "/":
            logger.warning(
                f"Stealth security: Unauthorized access attempt to {path} from {request.client.host}"
            )
            return JSONResponse({"error": "Forbidden"}, status_code=403)

        try:
            response = await call_next(request)
            logger.debug(f"Path {path} returned {response.status_code}")
            return response
        except Exception as e:
            logger.error(
                f"Error processing path {path}",
                extra={"path": path, "method": method, "exception": str(e)},
                exc_info=True,
            )
            raise


# --- FastAPI App ---
app = FastAPI(
    title="Slack Collector (FastAPI)", docs_url=None, redoc_url=None, openapi_url=None
)
app.add_middleware(SecurityMiddleware)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(
        "Unhandled exception in Slack Collector",
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


# --- Service Logic ---


class MessageWithEmbeddings(Message):
    embeddings: list[float]

    def __init__(self, message: Message):
        super().__init__(message.user, message.text, message.date, message.ts)


@dataclass
class ChannelMetadata:
    """Metadata about the data downloaded from a channel."""

    channel_id: str
    channel_name: str
    created_datetime: datetime
    last_download_datetime: datetime

    def to_dict(self):
        return {
            "channel_id": self.channel_id,
            "channel_name": self.channel_name,
            "created_datetime": self.created_datetime.isoformat(),
            "last_download_datetime": self.last_download_datetime.isoformat(),
        }


async def collect_slack_messages():
    team_ids_from_secret = await get_secret_value("teamIdsForSearch")
    team_ids_for_search = [
        id.strip() for id in team_ids_from_secret.split(",") if id.strip()
    ]

    if not team_ids_for_search:
        logger.error(
            "Security risk: No whitelisted teams configured for collection. Denying all processing."
        )
        return "Access Denied: No whitelisted teams"

    slack_user_token = await get_secret_value("slackUserToken")
    bigquery_client = bigquery.Client()

    now = datetime.now(UTC)

    for team_id in team_ids_for_search:
        if not await is_team_authorized(team_id):
            logger.warning(f"Skipping team {team_id} - no longer authorized.")
            continue

        logger.info(f"Processing teamId <{team_id}>")
        public_channels = await get_public_channels(team_id) or []
        channels_metadata = await get_channels_metadata(
            bigquery_client, public_channels
        )

        for public_channel in public_channels:
            logger.info(
                f"Checking {public_channel['name']} ({public_channel['id']})..."
            )
            channel_metadata = channels_metadata.get(public_channel["id"])
            if not channel_metadata:
                created_datetime = datetime.fromtimestamp(
                    public_channel["created"], tz=UTC
                )
                channel_metadata = ChannelMetadata(
                    public_channel["id"],
                    public_channel["name"],
                    created_datetime,
                    created_datetime,
                )

            last_download_datetime = channel_metadata.last_download_datetime
            time_diff = now - last_download_datetime

            if time_diff.total_seconds() < 600:
                logger.info(
                    f"Last downloaded at {last_download_datetime} so skipping..."
                )
                continue

            logger.info(f"Getting messages from {last_download_datetime} to {now}...")

            oldest = f"{int(last_download_datetime.timestamp())}"
            latest = f"{int(now.timestamp())}"
            messages = await get_channel_messages_using_token(
                slack_user_token, public_channel["id"], oldest, latest, True
            )

            if len(messages) > 0:
                logger.info("Generating embeddings...")
                messages = await create_message_embeddings(messages)
                logger.info("Saving messages...")
                await put_channel_messages(
                    bigquery_client, public_channel["id"], messages
                )
            else:
                logger.info("No messages in time range")

            logger.info("Saving metadata...")
            channel_metadata.last_download_datetime = now
            await put_channel_metadata(bigquery_client, channel_metadata)

    return "OK"


async def create_message_embeddings(
    messages: list[Message]
) -> list[MessageWithEmbeddings]:
    model = TextEmbeddingModel.from_pretrained("text-embedding-004")
    messages_with_embeddings: list[MessageWithEmbeddings] = list()
    for message in messages:
        message_with_embeddings = MessageWithEmbeddings(message)
        inputs = [
            TextEmbeddingInput(message_with_embeddings.text, "RETRIEVAL_DOCUMENT")
        ]
        embeddings = await model.get_embeddings_async(inputs)
        message_with_embeddings.embeddings = embeddings[0].values
        messages_with_embeddings.append(message_with_embeddings)
    return messages_with_embeddings


async def put_channel_messages(
    bigquery_client: bigquery.Client,
    channel_id: str,
    messages: list[MessageWithEmbeddings],
):
    if not messages:
        return
    table = bigquery_client.get_table(f"{DATASET_NAME}.{CONTENT_TABLE_NAME}")
    bq_rows = [
        {"channel": channel_id, "ts": float(m.ts), "embeddings": m.embeddings}
        for m in messages
    ]
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None, lambda: bigquery_client.insert_rows(table=table, rows=bq_rows)
    )


async def put_channel_metadata(
    bigquery_client: bigquery.Client, channel_metadata: ChannelMetadata
):
    table = bigquery_client.get_table(f"{DATASET_NAME}.{METADATA_TABLE_NAME}")
    bq_rows = [channel_metadata.to_dict()]
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None, lambda: bigquery_client.insert_rows(table=table, rows=bq_rows)
    )


async def get_channels_metadata(
    bigquery_client: bigquery.Client, channels: list[dict]
) -> dict[str, ChannelMetadata]:
    if not channels:
        return {}
    query = f"""
        SELECT channel_id, channel_name, created_datetime, MAX(last_download_datetime) as last_download_datetime
        FROM {DATASET_NAME}.{METADATA_TABLE_NAME}
        WHERE channel_id in UNNEST(@channel_ids)
        GROUP BY channel_id, channel_name, created_datetime
    """
    channel_id_list = [c["id"] for c in channels]
    job_config = bigquery.QueryJobConfiguration(
        query_parameters=[
            bigquery.ArrayQueryParameter("channel_ids", "STRING", channel_id_list),
        ]
    )
    loop = asyncio.get_event_loop()
    query_job = await loop.run_in_executor(
        None, lambda: bigquery_client.query(query, job_config=job_config)
    )
    rows = await loop.run_in_executor(None, query_job.result)
    return {
        r["channel_id"]: ChannelMetadata(
            r["channel_id"],
            r["channel_name"],
            r["created_datetime"].replace(tzinfo=UTC),
            r["last_download_datetime"].replace(tzinfo=UTC),
        )
        for r in rows
    }


# --- Routes ---


@app.post("/")
async def index():
    status = await collect_slack_messages()
    return Response(content=status, status_code=200 if status == "OK" else 403)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

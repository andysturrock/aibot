import os
import logging
from typing import List, Dict, Any
from dataclasses import dataclass
from datetime import datetime, timezone
import asyncio

from fastapi import FastAPI, Response, Request
from vertexai.language_models import TextEmbeddingInput, TextEmbeddingModel
from google.cloud import bigquery
from dotenv import load_dotenv

# Import from shared library
from shared import (
    get_secret_value, 
    Message, 
    get_public_channels, 
    get_channel_messages_using_token,
    is_team_authorized
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("slack-collector")

DATASET_NAME = "aibot_slack_messages"
CONTENT_TABLE_NAME = "slack_content"
METADATA_TABLE_NAME = "slack_content_metadata"

# --- FastAPI App ---
app = FastAPI(title="Slack Collector (FastAPI)")

# --- Service Logic ---

class MessageWithEmbeddings(Message):
    embeddings: List[float]

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
            'channel_id': self.channel_id,
            'channel_name': self.channel_name,
            'created_datetime': self.created_datetime.isoformat(),
            'last_download_datetime': self.last_download_datetime.isoformat()
        }

async def collect_slack_messages():
    team_ids_from_secret = await get_secret_value('AIBot', 'teamIdsForSearch')
    team_ids_for_search = [id.strip() for id in team_ids_from_secret.split(',') if id.strip()]
    
    if not team_ids_for_search:
        logger.error("Security risk: No whitelisted teams configured for collection. Denying all processing.")
        return "Access Denied: No whitelisted teams"

    slack_user_token = await get_secret_value('AIBot', 'slackUserToken')
    bigquery_client = bigquery.Client()

    now = datetime.now(timezone.utc)

    for team_id in team_ids_for_search:
        if not await is_team_authorized(team_id):
            logger.warning(f"Skipping team {team_id} - no longer authorized.")
            continue

        logger.info(f"Processing teamId <{team_id}>")
        public_channels = await get_public_channels(team_id) or []
        channels_metadata = await get_channels_metadata(bigquery_client, public_channels)
        
        for public_channel in public_channels:
            logger.info(f"Checking {public_channel['name']} ({public_channel['id']})...")
            channel_metadata = channels_metadata.get(public_channel['id'])
            if not channel_metadata:
                created_datetime = datetime.fromtimestamp(public_channel['created'], tz=timezone.utc)
                channel_metadata = ChannelMetadata(
                    public_channel['id'], public_channel['name'], created_datetime, created_datetime
                )
                
            last_download_datetime = channel_metadata.last_download_datetime
            time_diff = now - last_download_datetime
            
            if time_diff.total_seconds() < 600:
                logger.info(f"Last downloaded at {last_download_datetime} so skipping...")
                continue

            logger.info(f"Getting messages from {last_download_datetime} to {now}...")

            oldest = f"{int(last_download_datetime.timestamp())}"
            latest = f"{int(now.timestamp())}"
            messages = await get_channel_messages_using_token(slack_user_token,
                                                         public_channel['id'],
                                                         oldest,
                                                         latest,
                                                         True)

            if len(messages) > 0:
                logger.info("Generating embeddings...")
                messages = await create_message_embeddings(messages)
                logger.info("Saving messages...")
                await put_channel_messages(bigquery_client, public_channel['id'], messages)
            else:
                logger.info("No messages in time range")

            logger.info("Saving metadata...")
            channel_metadata.last_download_datetime = now
            await put_channel_metadata(bigquery_client, channel_metadata)
    
    return "OK"

async def create_message_embeddings(messages: List[Message]) -> List[MessageWithEmbeddings]:
    model = TextEmbeddingModel.from_pretrained("text-embedding-004")
    messages_with_embeddings: List[MessageWithEmbeddings] = list()
    for message in messages:
        message_with_embeddings = MessageWithEmbeddings(message)
        inputs = [TextEmbeddingInput(message_with_embeddings.text, "RETRIEVAL_DOCUMENT")]
        embeddings = await model.get_embeddings_async(inputs)
        message_with_embeddings.embeddings = embeddings[0].values
        messages_with_embeddings.append(message_with_embeddings)
    return messages_with_embeddings

async def put_channel_messages(bigquery_client: bigquery.Client, channel_id: str, messages: List[MessageWithEmbeddings]):
    if not messages: return
    table = bigquery_client.get_table(f"{DATASET_NAME}.{CONTENT_TABLE_NAME}")
    bq_rows = [{"channel": channel_id, "ts": float(m.ts), "embeddings": m.embeddings} for m in messages]
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: bigquery_client.insert_rows(table=table, rows=bq_rows))

async def put_channel_metadata(bigquery_client: bigquery.Client, channel_metadata: ChannelMetadata):
    table = bigquery_client.get_table(f"{DATASET_NAME}.{METADATA_TABLE_NAME}")
    bq_rows = [channel_metadata.to_dict()]
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: bigquery_client.insert_rows(table=table, rows=bq_rows))

async def get_channels_metadata(bigquery_client: bigquery.Client, channels: list[Dict]) -> dict[str, ChannelMetadata]:
    if not channels: return {}
    sql_channel_ids = ', '.join([f"\"{c['id']}\"" for c in channels])
    query = f"SELECT channel_id, channel_name, created_datetime, MAX(last_download_datetime) as last_download_datetime FROM {DATASET_NAME}.{METADATA_TABLE_NAME} WHERE channel_id in ({sql_channel_ids}) GROUP BY channel_id, channel_name, created_datetime"
    loop = asyncio.get_event_loop()
    query_job = await loop.run_in_executor(None, bigquery_client.query, query)
    rows = await loop.run_in_executor(None, query_job.result)
    return {r['channel_id']: ChannelMetadata(r['channel_id'], r['channel_name'], r['created_datetime'].replace(tzinfo=timezone.utc), r['last_download_datetime'].replace(tzinfo=timezone.utc)) for r in rows}

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

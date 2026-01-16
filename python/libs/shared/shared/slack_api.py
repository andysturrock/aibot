from typing import List, Optional, Dict, Any
from datetime import datetime
from dataclasses import dataclass
from .gcp_api import get_secret_value

from slack_sdk.web.async_client import AsyncWebClient
from slack_sdk.http_retry.builtin_handlers import RateLimitErrorRetryHandler

rate_limit_handler = RateLimitErrorRetryHandler(max_retry_count=5)

async def create_bot_client() -> AsyncWebClient:
    """Create an async client using the bot token"""
    bot_token = await get_secret_value('AIBot', 'slackBotToken')
    return await create_client_for_token(bot_token)

async def create_client_for_token(user_token: str) -> AsyncWebClient:
    """Create an async web client using the given token."""
    client = AsyncWebClient(token=user_token)
    # Note: RateLimitErrorRetryHandler might need adaptation for async if used inside loop,
    # but slack_sdk's AsyncWebClient handles some retries differently or via specific handlers.
    # For now, keeping it simple as AsyncWebClient is the primary goal.
    return client

@dataclass
class Message:
    """Type for holding message data"""
    user: str
    text: str
    date: datetime
    ts: str

def ts_to_date(ts: str) -> Optional[datetime]:
    """Convert Slack timestamp to datetime object"""
    if ts:
        try:
            seconds = int(ts.split(".")[0])
            return datetime.fromtimestamp(seconds)
        except (ValueError, IndexError):
            return None
    return None

async def _get_thread_messages(client: AsyncWebClient,
                               channel_id: str,
                               thread_ts: str,
                               oldest: Optional[str] = None,
                               latest: Optional[str] = None) -> List[Message]:
    """Get messages from a thread given a client (Async)"""
    replies = await client.conversations_replies(
        channel=channel_id,
        ts=thread_ts,
        oldest=oldest,
        latest=latest,
        inclusive=True
    )

    message_replies = [
        message for message in replies.data.get("messages", [])
        if message.get("type") == "message" and message.get("text", "").strip()
    ]
    messages: List[Message] = [
        Message(
            user=message.get("user", ""),
            text=message.get("text", ""),
            date=ts_to_date(message.get("ts")),
            ts=message.get("ts", "")
        )
        for message in message_replies
    ]
    return messages

async def get_channel_messages_using_token(token: str,
                                           channel_id: str,
                                           oldest: Optional[str] = None,
                                           latest: Optional[str] = None,
                                           include_threads: bool = True) -> List[Message]:
    """Get messages from a channel using the given token (Async)."""
    client = await create_client_for_token(token)
    return await _get_channel_messages(client, channel_id, oldest, latest, include_threads)

async def _get_channel_messages(client: AsyncWebClient,
                                channel_id: str,
                                oldest: Optional[str] = None,
                                latest: Optional[str] = None,
                                include_threads: bool = True) -> List[Message]:
    """Get messages from a channel (Async)."""
    history = await client.conversations_history(
        channel=channel_id,
        oldest=oldest,
        latest=latest,
        inclusive=True
    )

    if include_threads:
        messages: List[Message] = []
        for message in history.data.get("messages", []):
            if message.get("reply_count", 0) > 0 and message.get("ts"):
                thread_messages = await _get_thread_messages(
                    client, channel_id, message.get("ts"), oldest, latest)
                messages.extend(reversed(thread_messages))
            elif message.get("type") == "message" and message.get("text", "").strip():
                messages.append(
                    Message(
                        user=message.get("user", ""),
                        text=message.get("text", ""),
                        date=ts_to_date(message.get("ts")),
                        ts=message.get("ts", "")
                    )
                )
        return messages

    message_replies = [
        message for message in history.data.get("messages", [])
        if message.get("type") == "message"
    ]
    messages: List[Message] = [
        Message(
            user=message.get("user", ""),
            text=message.get("text", ""),
            ts=message.get("ts", ""),
            date=ts_to_date(message.get("ts")),
        )
        for message in message_replies
    ]
    return messages

async def get_public_channels(team_id: str) -> List[Dict[str, Any]]:
    """Get the public channels in the given team (Async)."""
    client = await create_bot_client()
    conversations_list = await client.conversations_list(
        team_id=team_id, types=["public_channel"])
    return conversations_list["channels"]

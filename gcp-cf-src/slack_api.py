"""
    Wrappers around Slack API functions.
"""
import json
from typing import List, Optional
from datetime import datetime
from dataclasses import dataclass

from gcp_api import get_secret_value

from slack_sdk import WebClient
# See https://slack.dev/python-slack-sdk/web/index.html#retryhandler
from slack_sdk.http_retry.builtin_handlers import RateLimitErrorRetryHandler
rate_limit_handler = RateLimitErrorRetryHandler(max_retry_count=5)


def create_bot_client():
    """Create a client using the bot token
    """
    bot_token = get_secret_value('AIBot', 'slackBotToken')
    return create_client_for_token(bot_token)


def create_client_for_token(user_token):
    """Create a web client using the given token.
    """
    client = WebClient(token=user_token)
    client.retry_handlers.append(rate_limit_handler)
    return client


@dataclass
class Message:
    """Type for holding message data
    """
    user: str
    text: str
    date: datetime
    ts: str


def ts_to_date(ts: str) -> Optional[datetime]:
    """Convert Slack timestamp to datetime object
    """
    if ts:
        seconds = int(ts.split(".")[0])
        return datetime.fromtimestamp(seconds)
    return None


def _get_thread_messages(client: WebClient,
                         channel_id: str,
                         thread_ts: str,
                         oldest: Optional[str] = None,
                         latest: Optional[str] = None) -> List[Message]:
    """Get messages from a thread given a client
    """
    replies = client.conversations_replies(
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


def get_channel_messages_using_token(token: str,
                                     channel_id: str,
                                     oldest: Optional[str] = None,
                                     latest: Optional[str] = None,
                                     include_threads: bool = True) -> List[Message]:
    """Get messages from a channel using the given token.
    """
    client = create_client_for_token(token)
    return _get_channel_messages(client, channel_id, oldest, latest, include_threads)


def _get_channel_messages(client: WebClient,
                          channel_id: str,
                          oldest: Optional[str] = None,
                          latest: Optional[str] = None,
                          include_threads: bool = True) -> List[Message]:
    """Get messages from a channel.
    """
    history = client.conversations_history(
        channel=channel_id,
        oldest=oldest,
        latest=latest,
        inclusive=True
    )

    if include_threads:
        messages: List[Message] = []
        for message in history.data.get("messages", []):
            if message.get("reply_count", 0) > 0 and message.get("ts"):
                thread_messages = _get_thread_messages(
                    client, channel_id, message.get("ts"), oldest, latest)
                # Thread messages are returned oldest first, channel messages newest first.
                # So reverse the thread messages to match the channel message ordering.
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


def get_public_channels(team_id: str):
    """Get the public channels in the given team.
    The team must be a workspace id (ie starts with T) not an Enterprise Grid id (starts with E)
    """
    client = create_bot_client()
    conversations_list = client.conversations_list(
        team_id=team_id, types=["public_channel"])
    return conversations_list["channels"]

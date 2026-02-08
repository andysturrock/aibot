from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from shared.slack_api import (
    Message,
    _get_channel_messages,
    create_bot_client,
    create_client_for_token,
    exchange_oauth_code,
    get_channel_messages_using_token,
    get_public_channels,
    ts_to_date,
)


def test_ts_to_date():
    assert ts_to_date("1707388800.000000") == datetime.fromtimestamp(1707388800)
    assert ts_to_date("") is None
    assert ts_to_date("invalid") is None


@pytest.mark.asyncio
async def test_create_client_for_token():
    client = await create_client_for_token("xoxp-test")
    assert client.token == "xoxp-test"


@pytest.mark.asyncio
async def test_create_bot_client():
    with patch("shared.slack_api.get_secret_value", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = "xoxb-bot"
        client = await create_bot_client()
        assert client.token == "xoxb-bot"


@pytest.mark.asyncio
async def test_get_public_channels():
    with patch(
        "shared.slack_api.create_bot_client", new_callable=AsyncMock
    ) as mock_create:
        mock_client = AsyncMock()
        mock_create.return_value = mock_client
        mock_client.conversations_list.return_value = {
            "channels": [{"id": "C1", "name": "general"}]
        }

        channels = await get_public_channels("T1")
        assert len(channels) == 1
        assert channels[0]["id"] == "C1"
        mock_client.conversations_list.assert_called_with(
            team_id="T1", types=["public_channel"]
        )


@pytest.mark.asyncio
async def test_exchange_oauth_code_success():
    with patch("shared.slack_api.get_secret_value", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = ["id", "secret"]
        with patch("shared.slack_api.AsyncWebClient") as MockClient:
            mock_instance = MockClient.return_value
            # oauth_v2_access returns a SlackResponse-like object
            mock_response = MagicMock()
            mock_response.__getitem__.side_effect = lambda key: {"ok": True}[key]
            mock_response.data = {"ok": True, "access_token": "xoxp-123"}
            mock_instance.oauth_v2_access = AsyncMock(return_value=mock_response)

            res = await exchange_oauth_code("code123")
            assert res["access_token"] == "xoxp-123"


@pytest.mark.asyncio
async def test_exchange_oauth_code_failure():
    with patch("shared.slack_api.get_secret_value", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = ["id", "secret"]
        with patch("shared.slack_api.AsyncWebClient") as MockClient:
            mock_instance = MockClient.return_value
            mock_instance.oauth_v2_access = AsyncMock(
                return_value={"ok": False, "error": "invalid_code"}
            )

            with pytest.raises(Exception, match="Slack OAuth exchange failed"):
                await exchange_oauth_code("code123")


@pytest.mark.asyncio
async def test_get_channel_messages_with_threads():
    mock_client = AsyncMock()
    # Mock history
    mock_client.conversations_history.return_value = MagicMock(
        data={
            "messages": [
                {"type": "message", "text": "parent", "ts": "100.0", "reply_count": 1},
                {"type": "message", "text": "standalone", "ts": "200.0"},
            ]
        }
    )
    # Mock replies
    mock_client.conversations_replies.return_value = MagicMock(
        data={
            "messages": [
                {"type": "message", "text": "parent", "ts": "100.0"},
                {"type": "message", "text": "reply", "ts": "101.0"},
            ]
        }
    )

    messages = await _get_channel_messages(mock_client, "C1", include_threads=True)
    # Expected: standalone, then reversed thread messages (reply, parent)
    # Actually code does: for each message, if reply_count > 0, thread_messages = get_thread_messages, then messages.extend(reversed(thread_messages))
    # else append standalone.
    # So: [reply (101.0), parent (100.0), standalone (200.0)]
    assert len(messages) == 3
    assert messages[0].text == "reply"
    assert messages[1].text == "parent"
    assert messages[2].text == "standalone"


@pytest.mark.asyncio
async def test_get_channel_messages_no_threads():
    mock_client = AsyncMock()
    mock_client.conversations_history.return_value = MagicMock(
        data={
            "messages": [
                {"type": "message", "text": "msg1", "ts": "1.0"},
                {"type": "message", "text": "msg2", "ts": "2.0"},
            ]
        }
    )

    messages = await _get_channel_messages(mock_client, "C1", include_threads=False)
    assert len(messages) == 2
    assert messages[0].text == "msg1"


@pytest.mark.asyncio
async def test_get_channel_messages_using_token():
    with patch(
        "shared.slack_api.create_client_for_token", new_callable=AsyncMock
    ) as mock_create:
        mock_client = AsyncMock()
        mock_create.return_value = mock_client
        with patch(
            "shared.slack_api._get_channel_messages", new_callable=AsyncMock
        ) as mock_get_internal:
            mock_get_internal.return_value = [
                Message("U1", "hi", datetime.now(), "1.0")
            ]

            msgs = await get_channel_messages_using_token("token", "C1")
            assert msgs[0].text == "hi"
            mock_create.assert_called_with("token")

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Set env vars BEFORE importing services
os.environ["GCP_LOCATION"] = "europe-west2"
os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"

from services.aibot_logic.agents import (  # noqa: E402
    get_valid_google_id_token,
    search_slack,
)


@pytest.mark.asyncio
async def test_get_valid_google_id_token_missing():
    with patch(
        "shared.google_auth.AIBotIdentityManager.refresh_user_tokens"
    ) as mock_refresh:
        mock_refresh.return_value = None
        token, error = await get_valid_google_id_token("U123")
        assert token is None
        assert "expired" in error


@pytest.mark.asyncio
async def test_get_valid_google_id_token_success():
    with patch(
        "shared.google_auth.AIBotIdentityManager.refresh_user_tokens"
    ) as mock_refresh:
        mock_refresh.return_value = "valid-token"
        token, error = await get_valid_google_id_token("U123")
        assert token == "valid-token"
        assert error is None


@pytest.mark.asyncio
async def test_search_slack_no_user():
    result = await search_slack("test query", "unknown")
    assert "don't know who you are" in result


@pytest.mark.asyncio
async def test_search_slack_mcp_failure():
    with (
        patch(
            "services.aibot_logic.agents.get_valid_google_id_token"
        ) as mock_user_token,
        patch("services.aibot_logic.agents.get_secret_value") as mock_secret,
        patch("google.oauth2.id_token.fetch_id_token") as mock_fetch,
        patch("services.aibot_logic.agents.sse_client") as mock_sse,
    ):
        mock_user_token.return_value = ("user-token", None)
        mock_secret.side_effect = ["iap-client", "http://mcp-url"]
        mock_fetch.return_value = "service-token"

        # Mocking the SSE context manager to fail
        mock_sse.side_effect = Exception("Connection refused")

        result = await search_slack("query", "U123")
        assert "Error searching Slack" in result


@pytest.mark.asyncio
async def test_search_slack_success():
    with (
        patch(
            "services.aibot_logic.agents.get_valid_google_id_token"
        ) as mock_user_token,
        patch("services.aibot_logic.agents.get_secret_value") as mock_secret,
        patch("google.oauth2.id_token.fetch_id_token") as mock_fetch,
        patch("services.aibot_logic.agents.sse_client") as mock_sse,
        patch("services.aibot_logic.agents.ClientSession") as mock_session_class,
    ):
        mock_user_token.return_value = ("user-token", None)
        mock_secret.side_effect = ["iap-client", "http://mcp-url"]
        mock_fetch.return_value = "service-token"

        # Mock SSE Context
        mock_sse_cm = MagicMock()
        mock_sse_cm.__aenter__.return_value = (MagicMock(), MagicMock())
        mock_sse.return_value = mock_sse_cm

        # Mock MCP Session
        mock_session = AsyncMock()
        mock_session_class.return_value.__aenter__.return_value = mock_session

        mock_result = MagicMock()
        mock_result.isError = False
        mock_result.content = [MagicMock(type="text", text="Found it!")]
        # Mock structured content to verify the new priority path
        mock_result.structuredContent = {"result": ["msg1", "msg2"]}
        mock_session.call_tool.return_value = mock_result

        result = await search_slack("query", "U123")
        # Expect JSON string of the result list
        import json

        assert result == json.dumps(["msg1", "msg2"], indent=2)
        mock_session.call_tool.assert_called_once()

import json
import os
from unittest.mock import AsyncMock, patch

# Ensure environment variables are set BEFORE any imports from services
os.environ["GCP_LOCATION"] = "europe-west2"
os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"

import pytest  # noqa: E402

from services.slack_search_mcp.main import user_id_ctx  # noqa: E402

# Setup app mock to handle initialization imports
with patch("shared.gcp_api.get_secret_value", new_callable=AsyncMock) as mock_sec:
    mock_sec.return_value = "dummy"


@pytest.mark.asyncio
async def test_search_tool_logic():
    # Test the internal search tool function mocking BQ and Vertex
    from services.slack_search_mcp.main import search_slack_messages

    with patch(
        "services.slack_search_mcp.main.get_secret_value", new_callable=AsyncMock
    ) as mock_sec:
        mock_sec.return_value = "token123"
        with patch(
            "services.slack_search_mcp.main.create_client_for_token",
            new_callable=AsyncMock,
        ) as mock_client_factory:
            mock_client = mock_client_factory.return_value
            mock_client.auth_test = AsyncMock(return_value={"team_id": "T123"})
            mock_client.team_info = AsyncMock(
                return_value={"ok": True, "team": {"domain": "test-team", "id": "T123"}}
            )

            # Mock conversations_info for reactive permission checks
            async def mock_info(channel):
                if channel == "C_PUB":
                    return {
                        "ok": True,
                        "channel": {
                            "id": "C_PUB",
                            "name": "public-gen",
                            "is_private": False,
                            "is_member": False,
                        },
                    }
                if channel == "C_PRIV":
                    return {
                        "ok": True,
                        "channel": {
                            "id": "C_PRIV",
                            "name": "private-sec",
                            "is_private": True,
                            "is_member": True,
                        },
                    }
                if channel == "C_HIDDEN":
                    return {
                        "ok": True,
                        "channel": {
                            "id": "C_HIDDEN",
                            "name": "secret-stuff",
                            "is_private": True,
                            "is_member": False,
                        },
                    }
                return {"ok": False, "error": "channel_not_found"}

            mock_client.conversations_info = AsyncMock(side_effect=mock_info)

            mock_client.users_info = AsyncMock(
                return_value={
                    "ok": True,
                    "user": {"real_name": "Test User", "id": "U123"},
                }
            )

            with patch(
                "services.slack_search_mcp.main.is_team_authorized", return_value=True
            ):
                with patch(
                    "services.slack_search_mcp.main.generate_embeddings",
                    return_value=[0.1],
                ):
                    # Mock BQ search to return messages from diverse channels
                    with patch(
                        "services.slack_search_mcp.main.perform_vector_search",
                        return_value=[
                            {"channel": "C_PUB", "ts": "1.1"},
                            {"channel": "C_PRIV", "ts": "2.1"},
                            {"channel": "C_HIDDEN", "ts": "3.1"},
                        ],
                    ):
                        # Mock replies for all channels
                        async def mock_replies(channel, ts, inclusive):
                            return {
                                "ok": True,
                                "messages": [
                                    {
                                        "text": f"msg in {channel}",
                                        "ts": ts,
                                        "user": "U123",
                                    }
                                ],
                            }

                        mock_client.conversations_replies = AsyncMock(
                            side_effect=mock_replies
                        )

                        # Set contextvar for the test
                        token = user_id_ctx.set("U123")
                        try:
                            result_json = await search_slack_messages("find something")
                        finally:
                            user_id_ctx.reset(token)

                        result = json.loads(result_json)
                        # Should have 2 messages (C_PUB and C_PRIV, C_HIDDEN filtered out)
                        assert len(result) == 2

                        # Verify metadata
                        pub_msg = next(m for m in result if m["channel_id"] == "C_PUB")
                        assert pub_msg["channel_name"] == "public-gen"
                        assert pub_msg["user_name"] == "Test User"

                        priv_msg = next(
                            m for m in result if m["channel_id"] == "C_PRIV"
                        )
                        assert priv_msg["channel_name"] == "private-sec"
                        assert priv_msg["user_name"] == "Test User"

                        # Verify C_HIDDEN is NOT in result
                        assert not any(m["channel_id"] == "C_HIDDEN" for m in result)

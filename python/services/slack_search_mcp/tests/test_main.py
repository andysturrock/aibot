import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.slack_search_mcp.main import user_id_ctx

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

            with patch(
                "services.slack_search_mcp.main.is_team_authorized", return_value=True
            ):
                with patch(
                    "services.slack_search_mcp.main.generate_embeddings",
                    return_value=[0.1],
                ):
                    with patch(
                        "services.slack_search_mcp.main.perform_vector_search",
                        return_value=[{"channel": "C1", "ts": "1.1"}],
                    ):
                        mock_client.conversations_replies = AsyncMock(
                            return_value={
                                "ok": True,
                                "messages": [{"text": "found it", "ts": "1.1"}],
                            }
                        )
                        mock_client.users_conversations = AsyncMock(
                            return_value={
                                "ok": True,
                                "channels": [{"id": "C1"}],
                                "response_metadata": {"next_cursor": ""},
                            }
                        )

                        # Set contextvar for the test
                        token = user_id_ctx.set("U123")
                        try:
                            result_json = await search_slack_messages("find something")
                        finally:
                            user_id_ctx.reset(token)

                        result = json.loads(result_json)
                        assert len(result) == 1
                        assert result[0]["text"] == "found it"


# We skip the SSE tests for now if they are hanging, focusing on the core tool logic and middleware class directly
@pytest.mark.asyncio
async def test_security_middleware_logic():
    from services.slack_search_mcp.main import SecurityMiddleware

    mock_app = MagicMock()
    middleware = SecurityMiddleware(mock_app)

    # Mock request
    request = MagicMock()
    request.url.path = "/mcp/sse"
    request.headers = {"X-Goog-IAP-JWT-Assertion": "dummy_jwt"}

    call_next = AsyncMock()

    with patch("services.slack_search_mcp.main.WebClient") as mock_web_client_class:
        mock_client = mock_web_client_class.return_value
        # Mock users_lookupByEmail to return a valid response
        mock_client.users_lookupByEmail = MagicMock(
            return_value={
                "ok": True,
                "user": {
                    "id": "U123",
                    "team_id": "T123",
                    "enterprise_id": None,
                },
            }
        )

        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            new_callable=AsyncMock,
        ) as mock_verify:
            mock_verify.return_value = {"email": "test@example.com"}
            with patch(
                "services.slack_search_mcp.main.get_secret_value",
                new_callable=AsyncMock,
            ) as mock_sec:
                mock_sec.side_effect = lambda k: {
                    "iapAudience": "aud123",
                    "slackBotToken": "bot123",
                }.get(k)

                with patch(
                    "services.slack_search_mcp.main.is_team_authorized",
                    return_value=True,
                ):
                    await middleware.dispatch(request, call_next)
                    call_next.assert_called_once()

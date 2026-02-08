import os
from unittest.mock import AsyncMock, patch

# Ensure environment variables are set BEFORE any imports from services
os.environ["GCP_LOCATION"] = "europe-west2"
os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"
os.environ["CUSTOM_FQDN"] = "https://test-fqdn.com"

import pytest  # noqa: E402
from mcp.types import CallToolResult  # noqa: E402

from services.slack_search_mcp.main import search_slack_messages  # noqa: E402


@pytest.mark.asyncio
async def test_search_robustness_empty_results():
    """Test that the tool returns a valid CallToolResult even when no messages are found."""
    with patch(
        "services.slack_search_mcp.main.get_secret_value", new_callable=AsyncMock
    ) as mock_secret:
        with patch(
            "services.slack_search_mcp.main.generate_embeddings",
            new_callable=AsyncMock,
        ) as mock_embed:
            with patch(
                "services.slack_search_mcp.main.perform_vector_search",
                new_callable=AsyncMock,
            ) as mock_search:
                mock_secret.return_value = "dummy-token"
                mock_embed.return_value = [0.1] * 768
                mock_search.return_value = []

                result = await search_slack_messages("test query")

                assert isinstance(result, CallToolResult)
                assert result.isError is False
                assert result.structuredContent["result"] == []
                assert "No messages found" in result.content[0].text


@pytest.mark.asyncio
async def test_search_robustness_exception_handling():
    """Test that exceptions result in an Error CallToolResult."""
    with patch(
        "services.slack_search_mcp.main.get_secret_value", new_callable=AsyncMock
    ) as mock_secret:
        mock_secret.return_value = "dummy-token"
        with patch(
            "services.slack_search_mcp.main.generate_embeddings",
            side_effect=Exception("API Down"),
        ):
            result = await search_slack_messages("test query")

            assert isinstance(result, CallToolResult)
            assert result.isError is True
            assert "API Down" in result.content[0].text


@pytest.mark.asyncio
async def test_search_robustness_malformed_input():
    """Test that the function stays alive even with unexpected input types."""
    with patch(
        "services.slack_search_mcp.main.get_secret_value", new_callable=AsyncMock
    ) as mock_secret:
        mock_secret.return_value = "dummy-token"
        with patch(
            "services.slack_search_mcp.main.generate_embeddings",
            side_effect=TypeError("Expected string"),
        ):
            result = await search_slack_messages(None)

            assert isinstance(result, CallToolResult)
            assert result.isError is True

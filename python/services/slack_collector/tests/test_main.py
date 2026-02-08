from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture(autouse=True)
def env_setup(monkeypatch):
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("K_SERVICE", "test-service")


with patch("shared.gcp_api.get_secret_value", new_callable=AsyncMock) as mock_sec:
    mock_sec.return_value = "dummy"
    from services.slack_collector.main import app


@pytest.mark.asyncio
async def test_collector_health():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_collect_slack_messages_success():
    # Mock Secrets
    with patch(
        "services.slack_collector.main.get_secret_value", new_callable=AsyncMock
    ) as mock_secrets:
        mock_secrets.side_effect = lambda k: (
            "T123" if k == "teamIdsForSearch" else "token_abc"
        )

        # Mock Authorized check
        with patch(
            "services.slack_collector.main.is_team_authorized", return_value=True
        ):
            # Mock BQ client
            with patch("services.slack_collector.main.bigquery.Client"):
                # Mock Public channels
                with patch(
                    "services.slack_collector.main.get_public_channels",
                    return_value=[
                        {"id": "C1", "name": "general", "created": 1700000000}
                    ],
                ):
                    # Mock Existing Metadata
                    with patch(
                        "services.slack_collector.main.get_channels_metadata",
                        return_value={},
                    ):
                        # Mock Message Fetching
                        with patch(
                            "services.slack_collector.main.get_channel_messages_using_token",
                            return_value=[MagicMock(ts="1.1", text="hi")],
                        ):
                            # Mock Embeddings
                            with patch(
                                "services.slack_collector.main.create_message_embeddings",
                                return_value=[
                                    MagicMock(ts="1.1", text="hi", embeddings=[0.1])
                                ],
                            ):
                                # Mock BQ Put
                                with patch(
                                    "services.slack_collector.main.put_channel_messages",
                                    new_callable=AsyncMock,
                                ):
                                    with patch(
                                        "services.slack_collector.main.put_channel_metadata",
                                        new_callable=AsyncMock,
                                    ):
                                        async with AsyncClient(
                                            transport=ASGITransport(app=app),
                                            base_url="http://test",
                                        ) as ac:
                                            response = await ac.post("/")

                                        assert response.status_code == 200
                                        assert response.text == "OK"


@pytest.mark.asyncio
async def test_collect_slack_messages_unauthorized_skip():
    with patch(
        "services.slack_collector.main.get_secret_value", new_callable=AsyncMock
    ) as mock_secrets:
        mock_secrets.return_value = "T_BAD"

        with patch(
            "services.slack_collector.main.is_team_authorized", return_value=False
        ):
            with patch("services.slack_collector.main.bigquery.Client"):
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as ac:
                    response = await ac.post("/")
                # It should finish successfully (OK) but skip processing the unauthorized team
                assert response.status_code == 200
                assert response.text == "OK"

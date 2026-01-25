import base64
import json
from unittest.mock import AsyncMock, patch

import pytest
from google.adk.events.event import Event
from google.genai import types
from httpx import ASGITransport, AsyncClient

# Import app but mock out the shared library calls within main.py
with patch.dict("os.environ", {
    "GCP_LOCATION": "us-central1",
    "GOOGLE_CLOUD_PROJECT": "test-project",
    "K_SERVICE": "test-service",
    "ENV": "test"
}):
    with patch("shared.gcp_api.get_secret_value", new_callable=AsyncMock) as mock_sec:
        # Set defaults for imports during initialization
        mock_sec.return_value = "dummy"
        from services.aibot_logic.main import app

@pytest.mark.asyncio
async def test_health_check():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

@pytest.mark.asyncio
async def test_slack_events_challenge():
    payload = {"type": "url_verification", "challenge": "test_challenge"}
    with patch("services.aibot_logic.main.verify_slack_request", return_value=True):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/slack/events", json=payload)
        assert response.status_code == 200
        assert response.json() == {"challenge": "test_challenge"}

@pytest.mark.asyncio
async def test_slack_events_authorized_success():
    payload = {"type": "event_callback", "team_id": "T123", "event": {"type": "app_mention"}}

    # Mock Security checks
    with patch("services.aibot_logic.main.verify_slack_request", return_value=True):
        with patch("services.aibot_logic.main.is_team_authorized", return_value=True):
            with patch("services.aibot_logic.main.publish_to_topic", new_callable=AsyncMock) as mock_pub:
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                    response = await ac.post("/slack/events", json=payload)
                assert response.status_code == 200
                assert response.text == "OK"
                mock_pub.assert_called()

@pytest.mark.asyncio
async def test_slack_events_unauthorized_team():
    payload = {"type": "event_callback", "team_id": "T_BAD", "event": {"type": "app_mention"}}

    with patch("services.aibot_logic.main.verify_slack_request", return_value=True):
        with patch("services.aibot_logic.main.is_team_authorized", return_value=False):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                response = await ac.post("/slack/events", json=payload)
            # Middleware returns 200 but descriptive text per my implementation
            assert response.status_code == 200
            assert response.text == "Unauthorized Workspace"

@pytest.mark.asyncio
async def test_slack_events_invalid_signature():
    payload = {"type": "event_callback"}

    with patch("services.aibot_logic.main.verify_slack_request", return_value=False):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/slack/events", json=payload)
        assert response.status_code == 401

@pytest.mark.asyncio
async def test_pubsub_worker_success():
    data = json.dumps({"type": "event_callback", "event": {"type": "app_mention", "user": "U123", "channel": "C1", "ts": "1.1", "text": "hi"}})
    encoded_data = base64.b64encode(data.encode()).decode()
    envelope = {"message": {"data": encoded_data}}

    with patch("services.aibot_logic.main.add_reaction", new_callable=AsyncMock):
        with patch("services.aibot_logic.main.remove_reaction", new_callable=AsyncMock):
            with patch("services.aibot_logic.main.get_history", return_value=[]):
                with patch("services.aibot_logic.main.create_supervisor_agent", new_callable=AsyncMock):
                    with patch("services.aibot_logic.main.Runner") as MockRunner:
                        mock_runner = MockRunner.return_value

                        # Mock run_async to be an async iterator
                        async def mock_run_async(*args, **kwargs):
                            yield Event(
                                author="assistant",
                                content=types.Content(
                                    role="assistant",
                                    parts=[types.Part(text="hello")]
                                )
                            )
                        mock_runner.run_async = mock_run_async

                        with patch("services.aibot_logic.main.post_message", new_callable=AsyncMock) as mock_post:
                            with patch("services.aibot_logic.main.put_history", new_callable=AsyncMock):
                                with patch("services.aibot_logic.main.create_bot_client", new_callable=AsyncMock) as mock_bot:
                                    mock_bot.return_value.auth_test = AsyncMock(return_value={"user_id": "B1"})

                                    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                                        response = await ac.post("/pubsub/worker", json=envelope)

                                    assert response.status_code == 200
                                    mock_post.assert_called_with("C1", "hello", thread_ts="1.1")

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from shared.gcp_api import get_secret_value, publish_to_topic


@pytest.mark.asyncio
async def test_get_secret_value_from_env():
    with patch("os.environ.get", return_value="env_val"):
        val = await get_secret_value("Secret")
        assert val == "env_val"


@pytest.mark.asyncio
async def test_get_secret_value_from_manager():
    # Mock environment to force secret manager path
    with patch(
        "os.environ.get",
        side_effect=lambda k, d=None: (
            "proj-123" if k == "GOOGLE_CLOUD_PROJECT" else None
        ),
    ):
        with patch(
            "shared.gcp_api.secretmanager_v1.SecretManagerServiceAsyncClient"
        ) as MockClient:
            mock_client = MockClient.return_value
            mock_response = MagicMock()
            mock_response.payload.data.decode.return_value = json.dumps(
                {"Secret": "secret_val"}
            )
            mock_client.access_secret_version = AsyncMock(return_value=mock_response)

            val = await get_secret_value("Secret")
            assert val == "secret_val"


@pytest.mark.asyncio
async def test_publish_to_topic_success():
    with patch("os.environ.get", return_value="proj-123"):
        with patch("shared.gcp_api.pubsub_v1.PublisherClient") as MockClient:
            mock_publisher = MockClient.return_value
            mock_publisher.topic_path.return_value = "path"

            mock_future = MagicMock()
            mock_future.result.return_value = "msg-id-123"
            mock_publisher.publish.return_value = mock_future

            # Using loop.run_in_executor mock
            with patch("asyncio.get_event_loop") as mock_loop:
                mock_loop.return_value.run_in_executor = AsyncMock(
                    return_value="msg-id-123"
                )

                msg_id = await publish_to_topic("topic", "payload")
                assert msg_id == "msg-id-123"

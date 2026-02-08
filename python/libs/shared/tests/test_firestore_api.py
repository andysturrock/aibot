import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from shared.firestore_api import (
    delete_google_token,
    delete_history,
    get_google_token,
    get_history,
    get_slack_id_by_email,
    put_google_token,
    put_history,
)


@pytest.mark.asyncio
async def test_get_history_found():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.get = AsyncMock()
        mock_doc.set = AsyncMock()

        mock_snapshot = MagicMock()  # Snapshot doesn't need to be async
        mock_snapshot.exists = True
        mock_snapshot.to_dict.return_value = {"history": json.dumps([{"text": "hi"}])}
        mock_doc.get.return_value = mock_snapshot

        history = await get_history("C1", "T1", "agent")
        assert history == [{"text": "hi"}]


@pytest.mark.asyncio
async def test_get_history_not_found():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.get = AsyncMock()
        mock_doc.set = AsyncMock()

        mock_snapshot = MagicMock()  # Snapshot doesn't need to be async
        mock_snapshot.exists = False
        mock_doc.get.return_value = mock_snapshot

        history = await get_history("C1", "T1", "agent")
        assert history is None


@pytest.mark.asyncio
async def test_put_history_success():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.set = AsyncMock()

        await put_history("C1", "T1", [{"text": "hi"}], "agent")
        mock_doc.set.assert_called()


@pytest.mark.asyncio
async def test_get_google_token():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.get = AsyncMock()

        mock_snapshot = MagicMock()
        mock_snapshot.exists = True
        mock_snapshot.to_dict.return_value = {"access_token": "token123"}
        mock_doc.get.return_value = mock_snapshot

        token_data = await get_google_token("U1")
        assert token_data["access_token"] == "token123"


@pytest.mark.asyncio
async def test_get_google_token_not_found():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.get = AsyncMock()

        mock_snapshot = MagicMock()
        mock_snapshot.exists = False
        mock_doc.get.return_value = mock_snapshot

        token_data = await get_google_token("U1")
        assert token_data is None


@pytest.mark.asyncio
async def test_put_google_token_removes_id_token():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.set = AsyncMock()

        token_data = {"access_token": "a", "id_token": "secret_id_token"}
        await put_google_token("U1", token_data)

        # check that id_token was popped
        args, _ = mock_doc.set.call_args
        saved_data = args[0]
        assert "id_token" not in saved_data
        assert saved_data["slack_id"] == "U1"


@pytest.mark.asyncio
async def test_delete_google_token():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.delete = AsyncMock()

        await delete_google_token("U1")
        mock_doc.delete.assert_called_once()


@pytest.mark.asyncio
async def test_delete_history():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.delete = AsyncMock()

        await delete_history("C1", "T1", "agent")
        mock_doc.delete.assert_called_once()


@pytest.mark.asyncio
async def test_get_slack_id_by_email_found():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_query = mock_db.collection.return_value.where.return_value

        mock_doc = MagicMock()
        mock_doc.id = "U123"

        async def mock_stream():
            yield mock_doc

        mock_query.stream.return_value = mock_stream()

        slack_id = await get_slack_id_by_email("test@example.com")
        assert slack_id == "U123"


@pytest.mark.asyncio
async def test_get_slack_id_by_email_not_found():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_query = mock_db.collection.return_value.where.return_value

        async def mock_stream_empty():
            if False:
                yield  # make it a generator
            return

        mock_query.stream.return_value = mock_stream_empty()

        slack_id = await get_slack_id_by_email("unknown@example.com")
        assert slack_id is None


@pytest.mark.asyncio
async def test_get_slack_id_by_email_empty():
    slack_id = await get_slack_id_by_email("")
    assert slack_id is None

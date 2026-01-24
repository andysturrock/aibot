import pytest
import json
from unittest.mock import AsyncMock, patch, MagicMock
from shared.firestore_api import get_history, put_history, get_access_token

@pytest.mark.asyncio
async def test_get_history_found():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.get = AsyncMock()
        mock_doc.set = AsyncMock()
        
        mock_snapshot = MagicMock() # Snapshot doesn't need to be async
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
        
        mock_snapshot = MagicMock() # Snapshot doesn't need to be async
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
async def test_get_access_token():
    with patch("shared.firestore_api.firestore.AsyncClient") as MockClient:
        mock_db = MockClient.return_value
        mock_doc = mock_db.collection.return_value.document.return_value
        mock_doc.get = AsyncMock()
        mock_doc.set = AsyncMock()
        
        mock_snapshot = MagicMock() # Snapshot doesn't need to be async
        mock_snapshot.exists = True
        mock_snapshot.to_dict.return_value = {"access_token": "token123"}
        mock_doc.get.return_value = mock_snapshot
        
        token = await get_access_token("U1")
        assert token == "token123"

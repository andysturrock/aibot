from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def mock_get_secret_value():
    with patch("shared.security.get_secret_value", new_callable=AsyncMock) as mock:
        yield mock

@pytest.fixture
def mock_is_team_authorized():
    with patch("shared.is_team_authorized", new_callable=AsyncMock) as mock:
        yield mock

@pytest.fixture
def mock_slack_client():
    with patch("shared.slack_api.AsyncWebClient", new_callable=AsyncMock) as mock:
        yield mock

@pytest.fixture
def mock_firestore_client():
    with patch("shared.firestore_api.firestore.AsyncClient") as mock:
        yield mock

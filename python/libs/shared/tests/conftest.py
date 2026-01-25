import os
from unittest.mock import AsyncMock, patch

import pytest

# Set default environment variables for all tests to avoid import-time OSErrors
os.environ.setdefault("GCP_LOCATION", "us-central1")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")
os.environ.setdefault("CUSTOM_FQDN", "test.example.com")
os.environ.setdefault("SLACK_SIGNING_SECRET", "test-secret")


@pytest.fixture
def mock_get_secret_value():
    with patch("shared.security.get_secret_value", new_callable=AsyncMock) as mock:
        yield mock

@pytest.fixture
def mock_is_team_authorized():
    with patch("shared.security.is_team_authorized", new_callable=AsyncMock) as mock:
        yield mock

@pytest.fixture
def mock_slack_client():
    with patch("shared.slack_api.AsyncWebClient", new_callable=AsyncMock) as mock:
        yield mock

@pytest.fixture
def mock_firestore_client():
    with patch("shared.firestore_api.firestore.AsyncClient") as mock:
        yield mock

import os
from unittest.mock import patch

import pytest

# Set default environment variables for all tests to avoid import-time OSErrors
# This root conftest ensures these are set before any service modules are imported
os.environ.setdefault("GCP_LOCATION", "us-central1")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")
os.environ.setdefault("CUSTOM_FQDN", "test.example.com")
os.environ.setdefault("SLACK_SIGNING_SECRET", "test-secret")
# os.environ.setdefault("K_SERVICE", "test-service")
# os.environ.setdefault("ENV", "test")


@pytest.fixture(autouse=True)
def mock_env_vars():
    """Ensure env vars are mocked even if someone tries to override them in os.environ."""
    with patch.dict(
        "os.environ",
        {
            "GCP_LOCATION": "us-central1",
            "GOOGLE_CLOUD_PROJECT": "test-project",
            "CUSTOM_FQDN": "test.example.com",
            "SLACK_SIGNING_SECRET": "test-secret",
            # "K_SERVICE": "test-service",
            # "ENV": "test",
        },
    ):
        yield

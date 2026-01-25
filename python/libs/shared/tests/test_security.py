from unittest.mock import patch

import pytest
from shared.security import (
    get_enterprise_id_from_payload,
    get_team_id_from_payload,
    is_team_authorized,
    verify_slack_request,
)


@pytest.mark.asyncio
async def test_is_team_authorized_success(mock_get_secret_value):
    # Mock whitelist from Secret Manager
    mock_get_secret_value.return_value = "T123,T456"

    # Force reset of cache for test
    with patch("shared.security._allowed_team_ids", None):
        assert await is_team_authorized("T123") is True
        assert await is_team_authorized("T456") is True
        assert await is_team_authorized("T789") is False

@pytest.mark.asyncio
async def test_is_enterprise_authorized_success(mock_get_secret_value):
    mock_get_secret_value.return_value = "T123"

    with patch("os.environ.get", return_value="E123"):
        with patch("shared.security._allowed_team_ids", None):
            assert await is_team_authorized("T999", "E123") is True
            assert await is_team_authorized("T999", "E456") is False

@pytest.mark.asyncio
async def test_is_team_authorized_empty_whitelist(mock_get_secret_value):
    mock_get_secret_value.return_value = ""
    with patch("shared.security._allowed_team_ids", None):
        assert await is_team_authorized("T123") is False

def test_get_team_id_from_payload():
    # Test different payload structures
    assert get_team_id_from_payload({"team_id": "T1"}) == "T1"
    assert get_team_id_from_payload({"event": {"team": "T2"}}) == "T2"
    assert get_team_id_from_payload({"team": {"id": "T3"}}) == "T3"
    assert get_team_id_from_payload({}) is None

def test_get_enterprise_id_from_payload():
    assert get_enterprise_id_from_payload({"enterprise_id": "E1"}) == "E1"
    assert get_enterprise_id_from_payload({"event": {"enterprise": "E2"}}) == "E2"
    assert get_enterprise_id_from_payload({}) is None

@pytest.mark.asyncio
async def test_verify_slack_request_valid(mock_get_secret_value):
    mock_get_secret_value.return_value = "secret"

    with patch("shared.security.SignatureVerifier") as MockVerifier:
        mock_verifier = MockVerifier.return_value
        mock_verifier.is_valid_request.return_value = True

        headers = {"X-Slack-Signature": "sig", "X-Slack-Request-Timestamp": "ts"}
        assert await verify_slack_request(b"data", headers) is True
        MockVerifier.assert_called_with("secret")

@pytest.mark.asyncio
async def test_verify_slack_request_invalid(mock_get_secret_value):
    mock_get_secret_value.return_value = "secret"

    with patch("shared.security.SignatureVerifier") as MockVerifier:
        mock_verifier = MockVerifier.return_value
        mock_verifier.is_valid_request.return_value = False

        assert await verify_slack_request(b"data", {}) is False

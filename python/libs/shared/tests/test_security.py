from unittest.mock import patch

import pytest
from shared.security import (
    get_enterprise_id_from_payload,
    get_iap_user_email,
    get_team_id_from_payload,
    is_team_authorized,
    is_user_authorized,
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
    # Map secrets to their expected values
    secrets_map = {"teamIdsForSearch": "T123", "enterpriseIdsForSearch": "E123"}
    mock_get_secret_value.side_effect = lambda k: secrets_map.get(k, "")

    with patch("os.environ.get", return_value="E123"):
        # Reset cache to force fresh load from mock
        from shared import security

        security._allowed_team_ids = None
        security._allowed_enterprise_ids = None

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


@pytest.mark.asyncio
async def test_is_user_authorized_success(mock_get_secret_value):
    secrets_map = {
        "teamIdsForSearch": "T123",
        "enterpriseIdsForSearch": "E123",
        "iapDomain": "example.com",
    }
    mock_get_secret_value.side_effect = lambda k: secrets_map.get(k, "")

    from shared import security

    security._allowed_team_ids = None  # reset

    assert await is_user_authorized("user@example.com", "T123") is True
    assert await is_user_authorized("user@other.com", "T123") is False
    assert await is_user_authorized(None, "T123") is False
    assert await is_user_authorized("user@example.com", "TWRONG") is False


@pytest.mark.asyncio
async def test_get_whitelists_error(mock_get_secret_value):
    mock_get_secret_value.side_effect = Exception("Secret fail")
    from shared import security

    security._allowed_team_ids = None
    teams, enterprises, domain = await security._get_whitelists()
    assert teams == []
    assert enterprises == []
    assert domain == ""


@pytest.mark.asyncio
async def test_verify_slack_request_exception(mock_get_secret_value):
    mock_get_secret_value.side_effect = Exception("error")
    assert await verify_slack_request(b"data", {}) is False


@pytest.mark.asyncio
async def test_get_iap_user_email():
    assert (
        await get_iap_user_email(
            {"X-Goog-Authenticated-User-Email": "accounts.google.com:user@test.com"}
        )
        == "user@test.com"
    )
    assert (
        await get_iap_user_email({"X-Goog-Authenticated-User-Email": "user@test.com"})
        == "user@test.com"
    )
    assert await get_iap_user_email({}) is None

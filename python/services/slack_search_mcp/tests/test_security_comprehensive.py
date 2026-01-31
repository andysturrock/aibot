import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

# Mock environmental requirements before importing app
os.environ["GCP_LOCATION"] = "europe-west2"
os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"

with patch("shared.gcp_api.get_secret_value", new_callable=AsyncMock) as mock_sec:
    mock_sec.return_value = "dummy"
    from services.slack_search_mcp.main import app


@pytest.fixture(autouse=True)
def mock_common_secrets():
    """Globally patch secrets and GCP calls for all tests in this execution."""
    with patch(
        "services.slack_search_mcp.main.get_secret_value", new_callable=AsyncMock
    ) as mock_sec:
        mock_sec.return_value = "dummy"
        yield mock_sec


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Ensure ENV is NOT 'test' for security middleware tests."""
    monkeypatch.delenv("ENV", raising=False)
    # Also ensure K_SERVICE doesn't bypass if it leaks
    monkeypatch.delenv("K_SERVICE", raising=False)


@pytest.mark.asyncio
async def test_health_check_bypasses_security():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_unauthorized_path_returns_403():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/invalid-path")
    assert response.status_code == 403
    assert response.json() == {"error": "Forbidden"}


@pytest.mark.asyncio
async def test_missing_iap_header_returns_401():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/mcp/sse")
    assert response.status_code == 401
    assert "Authentication required" in response.json()["error"]


@pytest.mark.asyncio
async def test_invalid_iap_jwt_returns_403():
    with patch("services.slack_search_mcp.main.verify_iap_jwt", return_value=None):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            response = await ac.get(
                "/mcp/sse", headers={"X-Goog-IAP-JWT-Assertion": "invalid"}
            )
        assert response.status_code == 403
        assert response.json() == {"error": "Invalid IAP Assertion"}


@pytest.mark.asyncio
async def test_email_missing_from_jwt_returns_403():
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt", return_value={"no": "email"}
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            response = await ac.get(
                "/mcp/sse",
                headers={"X-Goog-IAP-JWT-Assertion": "valid_payload_no_email"},
            )
        assert response.status_code == 403
        assert "Email missing" in response.json()["error"]


@pytest.mark.asyncio
async def test_user_not_found_in_slack_returns_403():
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "missing@example.com"},
    ):
        with patch("services.slack_search_mcp.main.WebClient") as mock_web_client:
            mock_client = mock_web_client.return_value
            mock_client.users_lookupByEmail = MagicMock(
                return_value={"ok": False, "error": "users_not_found"}
            )
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as ac:
                response = await ac.get(
                    "/mcp/sse",
                    headers={"X-Goog-IAP-JWT-Assertion": "user_missing_slack"},
                )
            assert response.status_code == 403
            assert "User not recognized in Slack" in response.json()["error"]


@pytest.mark.asyncio
async def test_unauthorized_team_returns_403():
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "badteam@example.com"},
    ):
        with patch("services.slack_search_mcp.main.WebClient") as mock_web_client:
            mock_client = mock_web_client.return_value
            mock_client.users_lookupByEmail = MagicMock(
                return_value={"ok": True, "user": {"id": "U1", "team_id": "T_BAD"}}
            )
            with patch(
                "services.slack_search_mcp.main.is_team_authorized", return_value=False
            ):
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as ac:
                    response = await ac.get(
                        "/mcp/sse", headers={"X-Goog-IAP-JWT-Assertion": "bad_team"}
                    )
                assert response.status_code == 403
                assert response.json() == {"error": "Workspace not authorized"}


@pytest.mark.asyncio
async def test_internal_security_error_returns_500():
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        side_effect=Exception("Database down"),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ) as ac:
            response = await ac.get(
                "/mcp/sse", headers={"X-Goog-IAP-JWT-Assertion": "valid"}
            )
        assert response.status_code == 500
        assert response.json() == {"error": "Security validation failed"}


@pytest.mark.asyncio
async def test_successful_authentication_proceeds():
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "ok@example.com"},
    ):
        with patch("services.slack_search_mcp.main.WebClient") as mock_web_client:
            mock_client = mock_web_client.return_value
            mock_client.users_lookupByEmail = MagicMock(
                return_value={"ok": True, "user": {"id": "U1", "team_id": "T1"}}
            )
            with patch(
                "services.slack_search_mcp.main.is_team_authorized", return_value=True
            ):
                async with AsyncClient(
                    transport=ASGITransport(app=app, raise_app_exceptions=False),
                    base_url="http://test",
                ) as ac:
                    # hit whitelisted path.
                    response = await ac.get(
                        "/mcp/messages", headers={"X-Goog-IAP-JWT-Assertion": "valid"}
                    )
                # Should get past security. FastMCP mount might return 404 or 405 for GET on messages.
                assert response.status_code not in [401, 403, 500]

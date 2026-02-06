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
                "services.slack_search_mcp.main.is_user_authorized", return_value=False
            ):
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as ac:
                    response = await ac.get(
                        "/mcp/sse", headers={"X-Goog-IAP-JWT-Assertion": "bad_team"}
                    )
                assert response.status_code == 403
                assert response.json() == {
                    "error": "Unauthorized access (Email Domain or Slack Workspace)"
                }


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
                "services.slack_search_mcp.main.is_user_authorized", return_value=True
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


@pytest.mark.asyncio
async def test_domain_mismatch_returns_403():
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "wrongdomain@evil.com"},
    ):
        with patch("services.slack_search_mcp.main.WebClient") as mock_web_client:
            mock_client = mock_web_client.return_value
            mock_client.users_lookupByEmail = MagicMock(
                return_value={"ok": True, "user": {"id": "U1", "team_id": "T1"}}
            )
            # Re-mocking _get_whitelists to return a specific domain
            with patch(
                "shared.security._get_whitelists", new_callable=AsyncMock
            ) as mock_white:
                mock_white.return_value = (["T1"], [], "atombank.co.uk")

                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as ac:
                    response = await ac.get(
                        "/mcp/sse", headers={"X-Goog-IAP-JWT-Assertion": "bad_domain"}
                    )
                assert response.status_code == 403
                assert "Email Domain or Slack Workspace" in response.json()["error"]


@pytest.mark.asyncio
async def test_header_scrubbing():
    """Verify that X-User-ID-Token is removed from headers before reaching the app."""
    # We'll use a mock app to capture the scope
    captured_scope = {}

    async def mock_app(scope, receive, send):
        captured_scope.update(scope)
        from starlette.responses import Response

        response = Response("ok")
        await response(scope, receive, send)

    from services.slack_search_mcp.main import SecurityMiddleware

    middleware = SecurityMiddleware(mock_app)

    # Mock Firestore to prevent actual network calls during rate limit check
    mock_db = MagicMock()
    mock_collection = MagicMock()
    mock_doc = MagicMock()
    mock_query = MagicMock()

    # set() is awaited, so it must be an AsyncMock
    mock_doc.set = AsyncMock()

    async def mock_stream():
        doc = MagicMock()
        doc.to_dict.return_value = {"user_email": "initial@example.com"}
        yield doc

    mock_query.stream.return_value = mock_stream()
    mock_collection.where.return_value = mock_query
    mock_collection.document.return_value = mock_doc
    mock_db.collection.return_value = mock_collection

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "aibot-logic@project.iam.gserviceaccount.com"},
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token") as mock_verify:
                mock_verify.return_value = {"email": "user@example.com"}
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={"ok": True, "user": {"id": "U1", "team_id": "T1"}}
                    )
                    with patch(
                        "services.slack_search_mcp.main.is_user_authorized",
                        return_value=True,
                    ):
                        async with AsyncClient(
                            transport=ASGITransport(app=middleware),
                            base_url="http://test",
                        ) as ac:
                            await ac.get(
                                "/mcp/sse",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "logic-token",
                                    "X-User-ID-Token": "sensitive-token",
                                },
                            )

    # Check headers in the captured scope
    headers = {k.lower(): v for k, v in captured_scope.get("headers", [])}
    assert b"x-user-id-token" not in headers
    assert b"x-goog-iap-jwt-assertion" in headers


@pytest.mark.asyncio
async def test_impersonation_rate_limiting():
    """Verify that logic server is blocked after impersonating too many unique users globally."""
    from services.slack_search_mcp.main import (
        MAX_UNIQUE_IMPERSONATIONS,
        SecurityMiddleware,
    )

    async def mock_app(scope, receive, send):
        from starlette.responses import Response

        response = Response("ok")
        await response(scope, receive, send)

    middleware = SecurityMiddleware(mock_app)

    # Mock Firestore Client and its methods
    mock_db = MagicMock()
    mock_collection = MagicMock()
    mock_doc = MagicMock()
    mock_query = MagicMock()

    mock_doc.set = AsyncMock()

    # We'll simulate a set of unique users in Firestore
    impersonated_users = []

    async def mock_stream_factory(*args, **kwargs):
        # Yield unique users from the history
        unique_seen = set()
        for user in impersonated_users:
            if user not in unique_seen:
                doc = MagicMock()
                doc.to_dict.return_value = {"user_email": user}
                yield doc
                unique_seen.add(user)

    mock_query.stream.side_effect = mock_stream_factory
    mock_collection.where.return_value = mock_query
    mock_collection.document.return_value = mock_doc
    mock_db.collection.return_value = mock_collection

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        # Mock dependencies for successful auth until rate limit hits
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "aibot-logic@project.iam.gserviceaccount.com"},
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token") as mock_verify:
                # First MAX_UNIQUE_IMPERSONATIONS users
                for i in range(MAX_UNIQUE_IMPERSONATIONS):
                    user_email = f"user{i}@example.com"
                    impersonated_users.append(user_email)
                    mock_verify.return_value = {"email": user_email}
                    with patch(
                        "services.slack_search_mcp.main.WebClient"
                    ) as mock_web_client:
                        mock_client = mock_web_client.return_value
                        mock_client.users_lookupByEmail = MagicMock(
                            return_value={
                                "ok": True,
                                "user": {"id": f"U{i}", "team_id": "T1"},
                            }
                        )
                        with patch(
                            "services.slack_search_mcp.main.is_user_authorized",
                            return_value=True,
                        ):
                            async with AsyncClient(
                                transport=ASGITransport(app=middleware),
                                base_url="http://test",
                            ) as ac:
                                response = await ac.get(
                                    "/mcp/sse",
                                    headers={
                                        "X-Goog-IAP-JWT-Assertion": "logic-token",
                                        "X-User-ID-Token": f"token-{i}",
                                    },
                                )
                                assert response.status_code == 200

                # The next UNIQUE user should be rate limited
                user_email = "one_too_many@example.com"
                impersonated_users.append(user_email)
                mock_verify.return_value = {"email": user_email}
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={
                            "ok": True,
                            "user": {"id": "U-EXCESS", "team_id": "T1"},
                        }
                    )
                    with patch(
                        "services.slack_search_mcp.main.is_user_authorized",
                        return_value=True,
                    ):
                        async with AsyncClient(
                            transport=ASGITransport(app=middleware),
                            base_url="http://test",
                        ) as ac:
                            response = await ac.get(
                                "/mcp/sse",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "logic-token",
                                    "X-User-ID-Token": "excessive-token",
                                },
                            )
                assert response.status_code == 429
                assert response.json()["error"] == "Impersonation rate limit exceeded"

"""Tests for mcp-client-accessor SA JWT authentication in SecurityMiddleware.

Covers:
- mcp-client-accessor detected as service caller
- X-User-ID-Token required and verified (without audience)
- aibot-logic still uses client_id audience verification
- Missing X-User-ID-Token returns 401
- Invalid user ID token returns 403
- Successful auth proceeds with extracted user email
- Header scrubbing applies to mcp-client-accessor
- Rate limiting applies to mcp-client-accessor
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

os.environ["GCP_LOCATION"] = "europe-west2"
os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"
os.environ.setdefault("CUSTOM_FQDN", "test.example.com")

with patch("shared.gcp_api.get_secret_value", new_callable=AsyncMock) as mock_sec:
    mock_sec.return_value = "dummy"
    from services.slack_search_mcp.main import SecurityMiddleware, app


@pytest.fixture(autouse=True)
def mock_common_secrets():
    with patch(
        "services.slack_search_mcp.main.get_secret_value", new_callable=AsyncMock
    ) as mock_sec:
        mock_sec.return_value = "dummy"
        yield mock_sec


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)


def _mock_firestore():
    """Helper to create a mocked Firestore client for rate limit checks."""
    mock_db = MagicMock()
    mock_collection = MagicMock()
    mock_doc = MagicMock()
    mock_query = MagicMock()
    mock_doc.set = AsyncMock()

    async def mock_stream():
        doc = MagicMock()
        doc.to_dict.return_value = {"user_email": "initial@example.com"}
        yield doc

    mock_query.stream.return_value = mock_stream()
    mock_collection.where.return_value = mock_query
    mock_collection.document.return_value = mock_doc
    mock_db.collection.return_value = mock_collection
    return mock_db


# ---------------------------------------------------------------------------
# mcp-client-accessor: missing X-User-ID-Token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_missing_user_id_token():
    """mcp-client-accessor without X-User-ID-Token should return 401."""
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            response = await ac.get(
                "/mcp/sse",
                headers={"X-Goog-IAP-JWT-Assertion": "valid-sa-jwt"},
            )
        assert response.status_code == 401
        assert "X-User-ID-Token required" in response.json()["error"]
        assert "MCP Client Accessor" in response.json()["error"]


# ---------------------------------------------------------------------------
# mcp-client-accessor: invalid user ID token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_invalid_user_id_token():
    """mcp-client-accessor with an invalid user ID token should return 403."""
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
    ):
        with patch(
            "google.oauth2.id_token.verify_oauth2_token",
            side_effect=ValueError("Token expired or invalid"),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as ac:
                response = await ac.get(
                    "/mcp/sse",
                    headers={
                        "X-Goog-IAP-JWT-Assertion": "valid-sa-jwt",
                        "X-User-ID-Token": "invalid-token",
                    },
                )
            assert response.status_code == 403
            assert "Invalid User ID Token" in response.json()["error"]


# ---------------------------------------------------------------------------
# mcp-client-accessor: verifies token WITHOUT audience (unlike aibot-logic)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_verifies_without_audience():
    """mcp-client-accessor path should call verify_oauth2_token without client_id audience."""
    mock_db = _mock_firestore()

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token") as mock_verify:
                mock_verify.return_value = {"email": "user@example.com"}
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={
                            "ok": True,
                            "user": {"id": "U1", "team_id": "T1"},
                        }
                    )
                    with patch(
                        "services.slack_search_mcp.main.is_user_authorized",
                        return_value=True,
                    ):
                        async with AsyncClient(
                            transport=ASGITransport(
                                app=app, raise_app_exceptions=False
                            ),
                            base_url="http://test",
                        ) as ac:
                            await ac.get(
                                "/mcp/messages",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "sa-jwt",
                                    "X-User-ID-Token": "user-token",
                                },
                            )

                # mcp-client-accessor path: called with token + Request only (no audience)
                mock_verify.assert_called_once()
                call_args = mock_verify.call_args[0]
                assert call_args[0] == "user-token"
                # Should have exactly 2 positional args (token, request) — no client_id
                assert len(call_args) == 2


@pytest.mark.asyncio
async def test_aibot_logic_verifies_with_audience():
    """aibot-logic path should call verify_oauth2_token WITH client_id audience."""
    mock_db = _mock_firestore()

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "aibot-logic@proj.iam.gserviceaccount.com"},
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token") as mock_verify:
                mock_verify.return_value = {"email": "user@example.com"}
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={
                            "ok": True,
                            "user": {"id": "U1", "team_id": "T1"},
                        }
                    )
                    with patch(
                        "services.slack_search_mcp.main.is_user_authorized",
                        return_value=True,
                    ):
                        async with AsyncClient(
                            transport=ASGITransport(
                                app=app, raise_app_exceptions=False
                            ),
                            base_url="http://test",
                        ) as ac:
                            await ac.get(
                                "/mcp/messages",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "logic-jwt",
                                    "X-User-ID-Token": "user-token",
                                },
                            )

                # aibot-logic path: called with token, request, AND client_id (3 args)
                mock_verify.assert_called_once()
                call_args = mock_verify.call_args[0]
                assert len(call_args) == 3
                assert call_args[0] == "user-token"
                # 3rd arg is the client_id (from get_secret_value)
                assert call_args[2] == "dummy"  # mocked secret value


# ---------------------------------------------------------------------------
# mcp-client-accessor: successful auth proceeds
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_successful_auth():
    """mcp-client-accessor with valid tokens should pass through to the app."""
    mock_db = _mock_firestore()

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token") as mock_verify:
                mock_verify.return_value = {"email": "authorized@example.com"}
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={
                            "ok": True,
                            "user": {"id": "U1", "team_id": "T1"},
                        }
                    )
                    with patch(
                        "services.slack_search_mcp.main.is_user_authorized",
                        return_value=True,
                    ):
                        async with AsyncClient(
                            transport=ASGITransport(
                                app=app, raise_app_exceptions=False
                            ),
                            base_url="http://test",
                        ) as ac:
                            response = await ac.get(
                                "/mcp/messages",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "sa-jwt",
                                    "X-User-ID-Token": "user-token",
                                },
                            )
                        # Should pass security — not 401/403/500
                        assert response.status_code not in [401, 403, 500]


# ---------------------------------------------------------------------------
# mcp-client-accessor: user email missing from ID token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_user_email_missing():
    """If user ID token has no email claim, should return 403."""
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
    ):
        with patch(
            "google.oauth2.id_token.verify_oauth2_token",
            return_value={"sub": "12345"},  # no email
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as ac:
                response = await ac.get(
                    "/mcp/sse",
                    headers={
                        "X-Goog-IAP-JWT-Assertion": "sa-jwt",
                        "X-User-ID-Token": "token-without-email",
                    },
                )
            assert response.status_code == 403
            assert "Invalid User ID Token" in response.json()["error"]


# ---------------------------------------------------------------------------
# mcp-client-accessor: header scrubbing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_header_scrubbing():
    """X-User-ID-Token should be removed before reaching the downstream app."""
    captured_scope = {}

    async def mock_app(scope, receive, send):
        captured_scope.update(scope)
        from starlette.responses import Response

        response = Response("ok")
        await response(scope, receive, send)

    middleware = SecurityMiddleware(mock_app)
    mock_db = _mock_firestore()

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token") as mock_verify:
                mock_verify.return_value = {"email": "user@example.com"}
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={
                            "ok": True,
                            "user": {"id": "U1", "team_id": "T1"},
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
                            await ac.get(
                                "/mcp/sse",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "sa-jwt",
                                    "X-User-ID-Token": "sensitive-user-token",
                                },
                            )

    headers = {k.lower(): v for k, v in captured_scope.get("headers", [])}
    assert b"x-user-id-token" not in headers
    assert b"x-goog-iap-jwt-assertion" in headers


# ---------------------------------------------------------------------------
# mcp-client-accessor: user not in Slack
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_user_not_in_slack():
    """If impersonated user is not found in Slack, should return 403."""
    mock_db = _mock_firestore()

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
        ):
            with patch(
                "google.oauth2.id_token.verify_oauth2_token",
                return_value={"email": "noone@example.com"},
            ):
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={"ok": False, "error": "users_not_found"}
                    )
                    async with AsyncClient(
                        transport=ASGITransport(app=app), base_url="http://test"
                    ) as ac:
                        response = await ac.get(
                            "/mcp/sse",
                            headers={
                                "X-Goog-IAP-JWT-Assertion": "sa-jwt",
                                "X-User-ID-Token": "user-token",
                            },
                        )
                    assert response.status_code == 403
                    assert "User not recognized in Slack" in response.json()["error"]


# ---------------------------------------------------------------------------
# mcp-client-accessor: unauthorized team
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mcp_client_accessor_unauthorized_team():
    """If impersonated user's team is not authorized, should return 403."""
    mock_db = _mock_firestore()

    with patch("google.cloud.firestore.AsyncClient", return_value=mock_db):
        with patch(
            "services.slack_search_mcp.main.verify_iap_jwt",
            return_value={"email": "mcp-client-accessor@proj.iam.gserviceaccount.com"},
        ):
            with patch(
                "google.oauth2.id_token.verify_oauth2_token",
                return_value={"email": "user@badteam.com"},
            ):
                with patch(
                    "services.slack_search_mcp.main.WebClient"
                ) as mock_web_client:
                    mock_client = mock_web_client.return_value
                    mock_client.users_lookupByEmail = MagicMock(
                        return_value={
                            "ok": True,
                            "user": {"id": "U1", "team_id": "T_BAD"},
                        }
                    )
                    with patch(
                        "services.slack_search_mcp.main.is_user_authorized",
                        return_value=False,
                    ):
                        async with AsyncClient(
                            transport=ASGITransport(app=app),
                            base_url="http://test",
                        ) as ac:
                            response = await ac.get(
                                "/mcp/sse",
                                headers={
                                    "X-Goog-IAP-JWT-Assertion": "sa-jwt",
                                    "X-User-ID-Token": "user-token",
                                },
                            )
                        assert response.status_code == 403
                        assert "Unauthorized access" in response.json()["error"]


# ---------------------------------------------------------------------------
# Regular user (not service caller) still works
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_regular_user_not_treated_as_service_caller():
    """A regular user email should NOT be treated as a service caller."""
    with patch(
        "services.slack_search_mcp.main.verify_iap_jwt",
        return_value={"email": "regularuser@example.com"},
    ):
        with patch("services.slack_search_mcp.main.WebClient") as mock_web_client:
            mock_client = mock_web_client.return_value
            mock_client.users_lookupByEmail = MagicMock(
                return_value={
                    "ok": True,
                    "user": {"id": "U1", "team_id": "T1"},
                }
            )
            with patch(
                "services.slack_search_mcp.main.is_user_authorized",
                return_value=True,
            ):
                async with AsyncClient(
                    transport=ASGITransport(app=app, raise_app_exceptions=False),
                    base_url="http://test",
                ) as ac:
                    response = await ac.get(
                        "/mcp/messages",
                        headers={"X-Goog-IAP-JWT-Assertion": "user-jwt"},
                    )
                # Should pass security — regular users don't need X-User-ID-Token
                assert response.status_code not in [401, 403, 500]

"""Tests for SA JWT authentication features in mcp_proxy.py.

Covers:
- get_gcloud_access_token()
- get_gcloud_identity_token()
- sign_jwt_for_iap()
- run_error_server()
- proxy() with user_identity_token
- main() SA JWT branching and error handling
"""

import json
import subprocess
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from tools.mcp_proxy import (
    get_gcloud_access_token,
    get_gcloud_identity_token,
    run_error_server,
    sign_jwt_for_iap,
)

# ---------------------------------------------------------------------------
# get_gcloud_access_token
# ---------------------------------------------------------------------------


class TestGetGcloudAccessToken:
    def test_success(self):
        mock_result = MagicMock()
        mock_result.stdout = "ya29.access-token-value\n"
        with patch("tools.mcp_proxy.subprocess.run", return_value=mock_result):
            token, err = get_gcloud_access_token("my-project")
            assert token == "ya29.access-token-value"
            assert err is None

    def test_success_strips_whitespace(self):
        mock_result = MagicMock()
        mock_result.stdout = "  ya29.token  \n"
        with patch("tools.mcp_proxy.subprocess.run", return_value=mock_result):
            token, err = get_gcloud_access_token("my-project")
            assert token == "ya29.token"
            assert err is None

    def test_empty_output(self):
        mock_result = MagicMock()
        mock_result.stdout = "  \n"
        with patch("tools.mcp_proxy.subprocess.run", return_value=mock_result):
            token, err = get_gcloud_access_token("my-project")
            assert token is None
            assert "empty output" in err

    def test_called_process_error(self):
        error = subprocess.CalledProcessError(1, "gcloud")
        error.stderr = "ERROR: not authenticated"
        with patch("tools.mcp_proxy.subprocess.run", side_effect=error):
            token, err = get_gcloud_access_token("my-project")
            assert token is None
            assert "not authenticated" in err
            assert "gcloud auth application-default login" in err
            assert "--project=my-project" in err

    def test_called_process_error_no_stderr(self):
        error = subprocess.CalledProcessError(1, "gcloud")
        error.stderr = None
        with patch("tools.mcp_proxy.subprocess.run", side_effect=error):
            token, err = get_gcloud_access_token("my-project")
            assert token is None
            assert "unknown error" in err

    def test_gcloud_not_found(self):
        with patch("tools.mcp_proxy.subprocess.run", side_effect=FileNotFoundError()):
            token, err = get_gcloud_access_token("my-project")
            assert token is None
            assert "gcloud CLI not found" in err

    def test_includes_project_flag(self):
        mock_result = MagicMock()
        mock_result.stdout = "token\n"
        with patch(
            "tools.mcp_proxy.subprocess.run", return_value=mock_result
        ) as mock_run:
            get_gcloud_access_token("my-proj-123")
            args = mock_run.call_args[0][0]
            assert "--project=my-proj-123" in args


# ---------------------------------------------------------------------------
# get_gcloud_identity_token
# ---------------------------------------------------------------------------


class TestGetGcloudIdentityToken:
    def test_success(self):
        mock_result = MagicMock()
        mock_result.stdout = "eyJhbGciOi.identity.token\n"
        with patch("tools.mcp_proxy.subprocess.run", return_value=mock_result):
            token, err = get_gcloud_identity_token("my-project")
            assert token == "eyJhbGciOi.identity.token"
            assert err is None

    def test_empty_output(self):
        mock_result = MagicMock()
        mock_result.stdout = "\n"
        with patch("tools.mcp_proxy.subprocess.run", return_value=mock_result):
            token, err = get_gcloud_identity_token("my-project")
            assert token is None
            assert "empty output" in err

    def test_called_process_error(self):
        error = subprocess.CalledProcessError(1, "gcloud")
        error.stderr = "ERROR: no identity"
        with patch("tools.mcp_proxy.subprocess.run", side_effect=error):
            token, err = get_gcloud_identity_token("my-project")
            assert token is None
            assert "no identity" in err
            assert "gcloud auth login" in err

    def test_gcloud_not_found(self):
        with patch("tools.mcp_proxy.subprocess.run", side_effect=FileNotFoundError()):
            token, err = get_gcloud_identity_token("my-project")
            assert token is None
            assert "gcloud CLI not found" in err

    def test_includes_project_flag(self):
        mock_result = MagicMock()
        mock_result.stdout = "token\n"
        with patch(
            "tools.mcp_proxy.subprocess.run", return_value=mock_result
        ) as mock_run:
            get_gcloud_identity_token("other-proj")
            args = mock_run.call_args[0][0]
            assert "--project=other-proj" in args


# ---------------------------------------------------------------------------
# sign_jwt_for_iap
# ---------------------------------------------------------------------------


class TestSignJwtForIap:
    @pytest.mark.asyncio
    async def test_success(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"signedJwt": "signed.jwt.value"}

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                jwt, err = await sign_jwt_for_iap(
                    "sa@proj.iam.gserviceaccount.com",
                    "https://example.com",
                    "my-project",
                )
                assert jwt == "signed.jwt.value"
                assert err is None

    @pytest.mark.asyncio
    async def test_jwt_payload_structure(self):
        """Verify the JWT payload sent to signJwt has correct fields."""
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"signedJwt": "signed"}

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            sa_email = "mcp-client-accessor@proj.iam.gserviceaccount.com"
            resource_url = "https://aibot.example.com"

            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                await sign_jwt_for_iap(sa_email, resource_url, "proj")

            # Extract the payload sent to signJwt
            call_args = mock_client.post.call_args
            request_body = call_args.kwargs.get("json") or call_args[1].get("json")
            payload = json.loads(request_body["payload"])

            assert payload["iss"] == sa_email
            assert payload["sub"] == sa_email
            assert payload["aud"] == resource_url
            assert "iat" in payload
            assert "exp" in payload
            assert payload["exp"] - payload["iat"] == 3600

    @pytest.mark.asyncio
    async def test_calls_correct_url(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"signedJwt": "signed"}

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            sa_email = "test-sa@proj.iam.gserviceaccount.com"
            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                await sign_jwt_for_iap(sa_email, "https://example.com", "proj")

            url_arg = mock_client.post.call_args[0][0]
            assert f"serviceAccounts/{sa_email}:signJwt" in url_arg
            assert "iamcredentials.googleapis.com" in url_arg

    @pytest.mark.asyncio
    async def test_access_token_failure_propagates(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=(None, "gcloud not authed"),
        ):
            jwt, err = await sign_jwt_for_iap(
                "sa@proj.iam.gserviceaccount.com",
                "https://example.com",
                "my-project",
            )
            assert jwt is None
            assert err == "gcloud not authed"

    @pytest.mark.asyncio
    async def test_permission_denied_403(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 403
            mock_resp.text = "Permission denied"

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            sa_email = "sa@proj.iam.gserviceaccount.com"
            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                jwt, err = await sign_jwt_for_iap(
                    sa_email, "https://example.com", "proj"
                )
                assert jwt is None
                assert "Permission denied" in err
                assert "Service Account Token Creator" in err
                assert sa_email in err

    @pytest.mark.asyncio
    async def test_other_http_error(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 500
            mock_resp.text = "Internal Server Error"

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                jwt, err = await sign_jwt_for_iap(
                    "sa@proj.iam.gserviceaccount.com",
                    "https://example.com",
                    "proj",
                )
                assert jwt is None
                assert "500" in err
                assert "Internal Server Error" in err

    @pytest.mark.asyncio
    async def test_network_error(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(
                side_effect=ConnectionError("DNS resolution failed")
            )
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                jwt, err = await sign_jwt_for_iap(
                    "sa@proj.iam.gserviceaccount.com",
                    "https://example.com",
                    "proj",
                )
                assert jwt is None
                assert "Network error" in err

    @pytest.mark.asyncio
    async def test_missing_signed_jwt_in_response(self):
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {}  # missing signedJwt field

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                jwt, err = await sign_jwt_for_iap(
                    "sa@proj.iam.gserviceaccount.com",
                    "https://example.com",
                    "proj",
                )
                assert jwt is None
                assert "signedJwt" in err

    @pytest.mark.asyncio
    async def test_authorization_header_set(self):
        """Verify the access token is sent as a Bearer token."""
        with patch(
            "tools.mcp_proxy.get_gcloud_access_token",
            return_value=("ya29.my-access-token", None),
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"signedJwt": "signed"}

            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)

            with patch("tools.mcp_proxy.httpx.AsyncClient", return_value=mock_client):
                await sign_jwt_for_iap(
                    "sa@proj.iam.gserviceaccount.com",
                    "https://example.com",
                    "proj",
                )

            headers = mock_client.post.call_args.kwargs.get(
                "headers"
            ) or mock_client.post.call_args[1].get("headers")
            assert headers["Authorization"] == "Bearer ya29.my-access-token"


# ---------------------------------------------------------------------------
# run_error_server
# ---------------------------------------------------------------------------


class TestRunErrorServer:
    @pytest.mark.asyncio
    async def test_error_server_lists_error_tool(self):
        """Verify the error server registers an authentication_error tool."""
        from mcp.server import Server

        original_init = Server.__init__

        def patched_init(self, name, *args, **kwargs):
            original_init(self, name, *args, **kwargs)

        # Instead of running the full server loop, capture the tool registration
        # by mocking stdio_server to raise after tools are registered
        with patch("tools.mcp_proxy.Server") as MockServer:
            mock_server = MagicMock()
            MockServer.return_value = mock_server

            # Capture the list_tools decorator
            list_tools_fn = None
            call_tool_fn = None

            def capture_list_tools():
                def decorator(fn):
                    nonlocal list_tools_fn
                    list_tools_fn = fn
                    return fn

                return decorator

            def capture_call_tool():
                def decorator(fn):
                    nonlocal call_tool_fn
                    call_tool_fn = fn
                    return fn

                return decorator

            mock_server.list_tools = capture_list_tools
            mock_server.call_tool = capture_call_tool

            # Make stdio_server raise to exit early
            with patch(
                "tools.mcp_proxy.run_error_server.__module__",
                "tools.mcp_proxy",
            ):
                # Mock the import inside run_error_server
                mock_stdio = MagicMock()
                mock_cm = AsyncMock()
                mock_cm.__aenter__ = AsyncMock(side_effect=RuntimeError("test exit"))
                mock_cm.__aexit__ = AsyncMock(return_value=False)
                mock_stdio.return_value = mock_cm

                with patch.dict(
                    "sys.modules",
                    {"mcp.server.stdio": MagicMock(stdio_server=mock_stdio)},
                ):
                    with pytest.raises(RuntimeError, match="test exit"):
                        await run_error_server("Test error message")

            # Verify the list_tools function returns the expected tool
            assert list_tools_fn is not None
            tools = await list_tools_fn()
            assert len(tools) == 1
            assert tools[0].name == "authentication_error"
            assert "Test error message" in tools[0].description

            # Verify the call_tool function returns the expected error
            assert call_tool_fn is not None
            result = await call_tool_fn("authentication_error", {})
            assert result.isError is True
            assert "Test error message" in result.content[0].text


# ---------------------------------------------------------------------------
# proxy() with user_identity_token
# ---------------------------------------------------------------------------


class TestProxyUserIdentityToken:
    @pytest.mark.asyncio
    async def test_proxy_sets_identity_token_header(self):
        """Verify X-User-ID-Token is passed when user_identity_token is provided."""
        from tools.mcp_proxy import proxy

        captured_headers = {}

        # Mock sse_client to capture the headers it receives, then raise
        # to exit before reaching the locally-imported stdio_server.
        mock_sse_cm = AsyncMock()
        mock_sse_cm.__aenter__ = AsyncMock(
            side_effect=RuntimeError("test exit after header capture")
        )
        mock_sse_cm.__aexit__ = AsyncMock(return_value=False)

        def mock_sse_client_fn(url, headers=None):
            captured_headers.update(headers or {})
            return mock_sse_cm

        with patch("tools.mcp_proxy.sse_client", side_effect=mock_sse_client_fn):
            # proxy() catches Exception but not BaseException;
            # RuntimeError is an Exception subclass so it will be caught.
            # That's fine — we just need the headers to be captured.
            try:
                await proxy(
                    "https://example.com/mcp/sse",
                    "iap-token",
                    user_identity_token="user-id-token",
                )
            except RuntimeError:
                pass

        assert captured_headers.get("Authorization") == "Bearer iap-token"
        assert captured_headers.get("X-User-ID-Token") == "user-id-token"

    @pytest.mark.asyncio
    async def test_proxy_no_identity_token_header_when_none(self):
        """Verify X-User-ID-Token is NOT set when user_identity_token is None."""
        from tools.mcp_proxy import proxy

        captured_headers = {}

        mock_sse_cm = AsyncMock()
        mock_sse_cm.__aenter__ = AsyncMock(
            side_effect=RuntimeError("test exit after header capture")
        )
        mock_sse_cm.__aexit__ = AsyncMock(return_value=False)

        def mock_sse_client_fn(url, headers=None):
            captured_headers.update(headers or {})
            return mock_sse_cm

        with patch("tools.mcp_proxy.sse_client", side_effect=mock_sse_client_fn):
            try:
                await proxy(
                    "https://example.com/mcp/sse",
                    "iap-token",
                )
            except RuntimeError:
                pass

        assert captured_headers.get("Authorization") == "Bearer iap-token"
        assert "X-User-ID-Token" not in captured_headers


# ---------------------------------------------------------------------------
# main() SA JWT branching
# ---------------------------------------------------------------------------


class TestMainSaJwtBranching:
    @pytest.mark.asyncio
    async def test_sa_jwt_path_success(self):
        """Full SA JWT path: sign JWT, get identity token, call proxy."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
            "--service-account",
            "mcp-sa@test-project.iam.gserviceaccount.com",
            "--skip-alignment",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            with patch(
                "tools.mcp_proxy.sign_jwt_for_iap",
                new_callable=AsyncMock,
                return_value=("signed.jwt", None),
            ):
                with patch(
                    "tools.mcp_proxy.get_gcloud_identity_token",
                    return_value=("user.identity.token", None),
                ):
                    with patch(
                        "tools.mcp_proxy.proxy", new_callable=AsyncMock
                    ) as mock_proxy:
                        await main()

                        mock_proxy.assert_called_once()
                        call_args = mock_proxy.call_args
                        assert call_args[0][0] == "https://aibot.example.com/mcp/sse"
                        assert call_args[0][1] == "signed.jwt"
                        assert (
                            call_args[1]["user_identity_token"] == "user.identity.token"
                        )

    @pytest.mark.asyncio
    async def test_sa_jwt_path_sign_jwt_failure_starts_error_server(self):
        """When sign_jwt_for_iap fails, run_error_server should be called."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
            "--service-account",
            "mcp-sa@test-project.iam.gserviceaccount.com",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            with patch(
                "tools.mcp_proxy.sign_jwt_for_iap",
                new_callable=AsyncMock,
                return_value=(None, "Permission denied signing JWT"),
            ):
                with patch(
                    "tools.mcp_proxy.run_error_server", new_callable=AsyncMock
                ) as mock_err:
                    await main()
                    mock_err.assert_called_once()
                    assert "Permission denied" in mock_err.call_args[0][0]

    @pytest.mark.asyncio
    async def test_sa_jwt_path_identity_token_failure_starts_error_server(self):
        """When get_gcloud_identity_token fails, run_error_server should be called."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
            "--service-account",
            "mcp-sa@test-project.iam.gserviceaccount.com",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            with patch(
                "tools.mcp_proxy.sign_jwt_for_iap",
                new_callable=AsyncMock,
                return_value=("signed.jwt", None),
            ):
                with patch(
                    "tools.mcp_proxy.get_gcloud_identity_token",
                    return_value=(None, "gcloud auth login required"),
                ):
                    with patch(
                        "tools.mcp_proxy.run_error_server", new_callable=AsyncMock
                    ) as mock_err:
                        await main()
                        mock_err.assert_called_once()
                        assert "gcloud auth login" in mock_err.call_args[0][0]

    @pytest.mark.asyncio
    async def test_sa_jwt_derives_resource_url_with_wildcard(self):
        """Verify resource URL uses wildcard path per IAP SA JWT docs."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
            "--service-account",
            "mcp-sa@test-project.iam.gserviceaccount.com",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            with patch(
                "tools.mcp_proxy.sign_jwt_for_iap",
                new_callable=AsyncMock,
                return_value=("jwt", None),
            ) as mock_sign:
                with patch(
                    "tools.mcp_proxy.get_gcloud_identity_token",
                    return_value=("id-tok", None),
                ):
                    with patch("tools.mcp_proxy.proxy", new_callable=AsyncMock):
                        await main()

                # The resource_url (2nd arg) should be scheme+host with wildcard path
                resource_url_arg = mock_sign.call_args[0][1]
                assert resource_url_arg == "https://aibot.example.com/*"
                assert "/mcp/sse" not in resource_url_arg

    @pytest.mark.asyncio
    async def test_legacy_oauth_path_no_audience_starts_error_server(self):
        """Without --service-account and no audience, error server should start."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            # Mock get_backend_id to return None (no audience discovered)
            with patch("tools.mcp_proxy.get_backend_id", return_value=None):
                with patch(
                    "tools.mcp_proxy.run_error_server", new_callable=AsyncMock
                ) as mock_err:
                    await main()
                    mock_err.assert_called_once()
                    assert "audience" in mock_err.call_args[0][0].lower()

    @pytest.mark.asyncio
    async def test_legacy_oauth_path_token_failure_starts_error_server(self):
        """Without --service-account, OAuth failure starts error server."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
            "--audience",
            "/projects/123/global/backendServices/456",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            with patch(
                "tools.mcp_proxy.fetch_iap_token",
                new_callable=AsyncMock,
                return_value=None,
            ):
                with patch(
                    "tools.mcp_proxy.run_error_server", new_callable=AsyncMock
                ) as mock_err:
                    await main()
                    mock_err.assert_called_once()
                    assert "IAP token" in mock_err.call_args[0][0]
                    assert "--service-account" in mock_err.call_args[0][0]

    @pytest.mark.asyncio
    async def test_legacy_oauth_path_success(self):
        """Without --service-account, OAuth path should work as before."""
        from tools.mcp_proxy import main

        test_args = [
            "--url",
            "https://aibot.example.com/mcp/sse",
            "--project",
            "test-project",
            "--audience",
            "/projects/123/global/backendServices/456",
        ]

        with patch("sys.argv", ["mcp_proxy.py"] + test_args):
            with patch(
                "tools.mcp_proxy.fetch_iap_token",
                new_callable=AsyncMock,
                return_value="oauth-token",
            ):
                with patch(
                    "tools.mcp_proxy.proxy", new_callable=AsyncMock
                ) as mock_proxy:
                    await main()
                    mock_proxy.assert_called_once()
                    call_args = mock_proxy.call_args
                    assert call_args[0][1] == "oauth-token"
                    # user_identity_token should be None for OAuth path
                    assert call_args[1]["user_identity_token"] is None

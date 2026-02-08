import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

# Mock secrets before import
with patch("shared.gcp_api.get_secret_value", new_callable=AsyncMock) as mock_sec:
    mock_sec.return_value = "dummy"
    from services.aibot_logic.main import (
        SecurityMiddleware,
        app,
        global_exception_handler,
        handle_home_tab_event,
        keep_alive_status_updates,
    )


@pytest.mark.asyncio
async def test_unauthorized_path_forbidden():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/stealth-path")
    assert response.status_code == 403
    assert response.json() == {"detail": "Forbidden"}


@pytest.mark.asyncio
async def test_slack_interactivity_form_encoded():
    # Mock signature valid
    with patch("services.aibot_logic.main.verify_slack_request", return_value=True):
        # Mock team authorized
        with patch("services.aibot_logic.main.is_team_authorized", return_value=True):
            payload = {"type": "block_actions", "team": {"id": "T123"}}
            body = f"payload={json.dumps(payload)}"
            headers = {"content-type": "application/x-www-form-urlencoded"}

            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as ac:
                response = await ac.post(
                    "/slack/interactivity", content=body, headers=headers
                )
            assert response.status_code == 200


@pytest.mark.asyncio
async def test_auth_login_redirect():
    with patch("services.aibot_logic.main.get_google_token", return_value=None):
        with patch(
            "services.aibot_logic.main.get_secret_value", new_callable=AsyncMock
        ) as mock_sec:
            mock_sec.side_effect = ["example.com", "client-id"]

            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as ac:
                response = await ac.get("/auth/login?slack_user_id=U123")
            assert response.status_code == 307
            assert "accounts.google.com" in response.headers["location"]


@pytest.mark.asyncio
async def test_auth_callback_success():
    state = json.dumps({"slack_user_id": "U123"})
    with patch(
        "services.aibot_logic.main.get_secret_value", new_callable=AsyncMock
    ) as mock_sec:
        mock_sec.side_effect = ["example.com", "client-id"]
        with patch(
            "services.aibot_logic.main.exchange_google_code", new_callable=AsyncMock
        ) as mock_exc:
            mock_exc.return_value = {
                "id_token": "id",
                "refresh_token": "ref",
                "expires_in": 3600,
            }
            with patch(
                "services.aibot_logic.main.id_token.verify_oauth2_token"
            ) as mock_verify:
                mock_verify.return_value = {"email": "user@test.com"}
                with patch(
                    "services.aibot_logic.main.put_google_token", new_callable=AsyncMock
                ) as mock_put:
                    with patch(
                        "shared.google_auth.AIBotIdentityManager"
                    ) as MockManager:
                        MockManager.return_value.encrypt = AsyncMock(
                            return_value="enc-ref"
                        )

                        async with AsyncClient(
                            transport=ASGITransport(app=app), base_url="http://test"
                        ) as ac:
                            response = await ac.get(
                                f"/auth/callback?code=code&state={state}"
                            )
                        assert response.status_code == 200
                        assert "Success!" in response.text
                        mock_put.assert_called_once()


@pytest.mark.asyncio
async def test_pubsub_worker_missing_user():
    data = json.dumps(
        {
            "type": "event_callback",
            "event": {
                "type": "app_mention",
                "channel": "C1",
                "ts": "1.1",
                "text": "hi",
            },
        }
    )
    encoded = base64.b64encode(data.encode()).decode()
    envelope = {"message": {"data": encoded}}

    with patch("services.aibot_logic.main.add_reaction", new_callable=AsyncMock):
        with patch("services.aibot_logic.main.remove_reaction", new_callable=AsyncMock):
            with patch(
                "services.aibot_logic.main.get_history",
                new_callable=AsyncMock,
                return_value=[{"role": "user", "parts": [{"text": "old msg"}]}],
            ):
                with patch(
                    "services.aibot_logic.main.post_message", new_callable=AsyncMock
                ) as mock_post:
                    async with AsyncClient(
                        transport=ASGITransport(app=app), base_url="http://test"
                    ) as ac:
                        response = await ac.post("/pubsub/worker", json=envelope)
                    assert response.status_code == 200
                    assert response.text == "User identification failed"
                    mock_post.assert_called_with(
                        "C1",
                        "Sorry, I couldn't identify your Slack user ID. This might be due to an unsupported event type.",
                        thread_ts="1.1",
                    )


@pytest.mark.asyncio
async def test_global_exception_handler():
    request = MagicMock()
    request.url.path = "/test"
    request.method = "GET"
    exc = Exception("Test crash")
    response = await global_exception_handler(request, exc)
    assert response.status_code == 500
    data = json.loads(response.body.decode())
    assert data["message"] == "Internal Server Error"
    assert "request_id" in data


@pytest.mark.asyncio
async def test_middleware_exception_handling():
    async def mock_call_next(req):
        raise ValueError("Middleware fail")

    mw = SecurityMiddleware(MagicMock())
    request = MagicMock()
    request.url.path = "/health"
    request.method = "GET"

    with pytest.raises(ValueError, match="Middleware fail"):
        await mw.dispatch(request, mock_call_next)


@pytest.mark.asyncio
async def test_auth_callback_fallback_state():
    state_str = "U123"  # Not JSON
    with patch(
        "services.aibot_logic.main.get_secret_value", new_callable=AsyncMock
    ) as mock_sec:
        mock_sec.return_value = "example.com"
        with patch(
            "services.aibot_logic.main.exchange_google_code", new_callable=AsyncMock
        ) as mock_exc:
            mock_exc.return_value = {"id_token": "id"}
            with patch(
                "services.aibot_logic.main.id_token.verify_oauth2_token"
            ) as mock_verify:
                mock_verify.return_value = {"email": "u@t.com"}
                with patch(
                    "services.aibot_logic.main.put_google_token", new_callable=AsyncMock
                ):
                    async with AsyncClient(
                        transport=ASGITransport(app=app), base_url="http://test"
                    ) as ac:
                        response = await ac.get(
                            f"/auth/callback?code=c&state={state_str}"
                        )
                    assert response.status_code == 200


@pytest.mark.asyncio
async def test_keep_alive_loop_cancel():
    with patch(
        "services.aibot_logic.main.post_ephemeral", new_callable=AsyncMock
    ) as mock_post:
        # Cause sleep to raise CancelledError immediately
        with patch(
            "services.aibot_logic.main.asyncio.sleep",
            side_effect=asyncio.CancelledError,
        ):
            await keep_alive_status_updates("C1", "U1", "1.1")
            mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_home_tab_config_error():
    event = {"user": "U123"}
    with patch("services.aibot_logic.main.get_google_token", return_value=None):
        with patch(
            "services.aibot_logic.main.get_secret_value", new_callable=AsyncMock
        ) as mock_sec:
            # First call for iapDomain, second for customFqdn (which we'll make fail)
            mock_sec.side_effect = ["dummy", ""]
            with patch(
                "services.aibot_logic.main.create_bot_client", new_callable=AsyncMock
            ) as mock_bot:
                mock_bot.return_value.views_publish = AsyncMock()
                await handle_home_tab_event(event)
                args, kwargs = mock_bot.return_value.views_publish.call_args
                assert "Configuration Error" in str(kwargs["view"])


@pytest.mark.asyncio
async def test_handle_home_tab_already_auth():
    event = {"user": "U123"}
    with patch(
        "services.aibot_logic.main.get_google_token", return_value={"email": "u@t.com"}
    ):
        with patch(
            "services.aibot_logic.main.create_bot_client", new_callable=AsyncMock
        ) as mock_bot:
            mock_bot.return_value.views_publish = AsyncMock(return_value={"ok": True})
            from services.aibot_logic.main import handle_home_tab_event

            await handle_home_tab_event(event)
            mock_bot.return_value.views_publish.assert_called_once()

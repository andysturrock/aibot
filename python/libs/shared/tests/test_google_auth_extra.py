from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from shared.google_auth import (
    AIBotIdentityManager,
    exchange_google_code,
    refresh_google_id_token,
    verify_iap_jwt,
)


@pytest.mark.asyncio
async def test_aibot_identity_manager_kms_lazy_init():
    with patch("google.cloud.kms.KeyManagementServiceClient") as mock_kms:
        manager = AIBotIdentityManager(kms_key_path="test-key")
        assert manager._kms_client is None
        client = manager.kms_client
        assert client is not None
        mock_kms.assert_called_once()


@pytest.mark.asyncio
async def test_encrypt_decrypt():
    manager = AIBotIdentityManager(kms_key_path="test-key")
    mock_client = MagicMock()
    manager._kms_client = mock_client

    # Mock Encrypt
    mock_encrypt_resp = MagicMock()
    mock_encrypt_resp.ciphertext = b"encrypted-data"
    mock_client.encrypt.return_value = mock_encrypt_resp

    ciphertext = await manager.encrypt("plaintext")
    assert ciphertext is not None
    mock_client.encrypt.assert_called_once()

    # Mock Decrypt
    mock_decrypt_resp = MagicMock()
    mock_decrypt_resp.plaintext = b"plaintext"
    mock_client.decrypt.return_value = mock_decrypt_resp

    decrypted = await manager.decrypt(ciphertext)
    assert decrypted == "plaintext"
    mock_client.decrypt.assert_called_once()


@pytest.mark.asyncio
async def test_refresh_user_tokens_success():
    with (
        patch("shared.google_auth.get_google_token") as mock_get,
        patch("shared.google_auth.get_secret_value") as mock_secret,
        patch("shared.google_auth.Credentials") as mock_creds_class,
        patch("shared.google_auth.put_google_token") as mock_put,
    ):
        manager = AIBotIdentityManager(kms_key_path="test-key")
        manager.decrypt = AsyncMock(return_value="raw-refresh-token")
        manager.encrypt = AsyncMock(return_value="new-encrypted-refresh")

        mock_get.return_value = {"refresh_token": "enc-refresh"}
        mock_secret.side_effect = ["client-id", "client-secret"]

        mock_creds = MagicMock()
        mock_creds.id_token = "new-id-token"
        mock_creds.refresh_token = "rotated-refresh-token"
        mock_creds_class.return_value = mock_creds

        id_token_val = await manager.refresh_user_tokens("U123")

        assert id_token_val == "new-id-token"
        mock_creds.refresh.assert_called_once()
        mock_put.assert_called_once()


@pytest.mark.asyncio
async def test_encrypt_kms_error():
    manager = AIBotIdentityManager(kms_key_path="test-key")
    mock_client = MagicMock()
    manager._kms_client = mock_client
    mock_client.encrypt.side_effect = Exception("KMS Down")

    with pytest.raises(Exception, match="KMS Down"):
        await manager.encrypt("plaintext")


@pytest.mark.asyncio
async def test_refresh_user_tokens_no_token_data():
    with patch("shared.google_auth.get_google_token") as mock_get:
        mock_get.return_value = None
        manager = AIBotIdentityManager(kms_key_path="test-key")
        res = await manager.refresh_user_tokens("U123")
        assert res is None


@pytest.mark.asyncio
async def test_refresh_user_tokens_no_refresh_token():
    with patch("shared.google_auth.get_google_token") as mock_get:
        mock_get.return_value = {"something": "else"}
        manager = AIBotIdentityManager(kms_key_path="test-key")
        res = await manager.refresh_user_tokens("U123")
        assert res is None


@pytest.mark.asyncio
async def test_refresh_user_tokens_rotation_no_new_refresh():
    with (
        patch("shared.google_auth.get_google_token") as mock_get,
        patch("shared.google_auth.get_secret_value") as mock_secret,
        patch("shared.google_auth.Credentials") as mock_creds_class,
        patch("shared.google_auth.put_google_token") as mock_put,
    ):
        manager = AIBotIdentityManager(kms_key_path="test-key")
        manager.decrypt = AsyncMock(return_value="raw-refresh")

        mock_get.return_value = {"refresh_token": "enc-refresh"}
        mock_secret.side_effect = ["client-id", "client-secret"]

        mock_creds = MagicMock()
        mock_creds.id_token = "new-id"
        mock_creds.refresh_token = "raw-refresh"  # Same as old, no rotation
        mock_creds_class.return_value = mock_creds

        id_token_val = await manager.refresh_user_tokens("U123")
        assert id_token_val == "new-id"
        mock_put.assert_not_called()


@pytest.mark.asyncio
async def test_verify_iap_jwt_success():
    with patch("google.oauth2.id_token.verify_token") as mock_verify:
        mock_verify.return_value = {"email": "test@example.com"}
        payload = await verify_iap_jwt("jwt-assertion", "expected-aud")
        assert payload == {"email": "test@example.com"}


@pytest.mark.asyncio
async def test_verify_iap_jwt_failure():
    with patch("google.oauth2.id_token.verify_token") as mock_verify:
        mock_verify.side_effect = Exception("Audience mismatch")
        payload = await verify_iap_jwt("jwt-assertion", "wrong-aud")
        assert payload is None


@pytest.mark.asyncio
async def test_exchange_google_code_success(respx_mock):
    with patch("shared.google_auth.get_secret_value") as mock_secret:
        mock_secret.side_effect = ["client-id", "client-secret"]
        respx_mock.post("https://oauth2.googleapis.com/token").respond(
            json={"access_token": "acc", "id_token": "id"}
        )
        tokens = await exchange_google_code("code", "redirect")
        assert tokens["id_token"] == "id"


@pytest.mark.asyncio
async def test_refresh_google_id_token_failure(respx_mock):
    with patch("shared.google_auth.get_secret_value") as mock_secret:
        mock_secret.side_effect = ["client-id", "client-secret"]
        respx_mock.post("https://oauth2.googleapis.com/token").respond(
            status_code=400, text="error"
        )
        token = await refresh_google_id_token("refresh")
        assert token is None


@pytest.mark.asyncio
async def test_refresh_user_tokens_refresh_failure():
    with (
        patch("shared.google_auth.get_google_token") as mock_get,
        patch("shared.google_auth.get_secret_value") as mock_secret,
        patch("shared.google_auth.Credentials") as mock_creds_class,
    ):
        manager = AIBotIdentityManager(kms_key_path="test-key")
        manager.decrypt = AsyncMock(return_value="raw-refresh")

        mock_get.return_value = {"refresh_token": "enc-refresh"}
        mock_secret.side_effect = ["client-id", "client-secret"]

        mock_creds = MagicMock()
        mock_creds.refresh.side_effect = Exception("Refresh API Error")
        mock_creds_class.return_value = mock_creds

        res = await manager.refresh_user_tokens("U123")
        assert res is None


@pytest.mark.asyncio
async def test_verify_iap_jwt_log_cases():
    with patch("google.oauth2.id_token.verify_token") as mock_verify:
        # Case 1: Audience mismatch
        mock_verify.side_effect = Exception("Audience mismatch")
        await verify_iap_jwt("jwt", "expected")

        # Case 2: Email claim issue
        mock_verify.side_effect = Exception("Email claim issue")
        await verify_iap_jwt("jwt", "expected")


@pytest.mark.asyncio
async def test_refresh_google_id_token_success(respx_mock):
    with patch("shared.google_auth.get_secret_value") as mock_secret:
        mock_secret.side_effect = ["client-id", "client-secret"]
        respx_mock.post("https://oauth2.googleapis.com/token").respond(
            json={"id_token": "fresh-id-token"}
        )
        token = await refresh_google_id_token("refresh")
        assert token == "fresh-id-token"


def test_get_google_auth_url():
    from shared.google_auth import get_google_auth_url

    url = get_google_auth_url("cid", "ruri", "state123")
    assert "cid" in url
    assert "ruri" in url
    assert "state123" in url
    assert "scope=openid+email+profile" in url

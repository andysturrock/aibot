import base64
import logging
import os
from typing import Any

import cachecontrol
import httpx
import requests
from google.auth.transport.requests import Request as AuthRequest
from google.cloud import kms
from google.oauth2 import id_token
from google.oauth2.credentials import Credentials

from shared.firestore_api import get_google_token, put_google_token
from shared.gcp_api import get_secret_value

logger = logging.getLogger("google-auth")

IAP_CERTS_URL = "https://www.gstatic.com/iap/verify/public_key"

# Create a cached session to avoid fetching certs on every request
# Use a standard requests Session wrapped with CacheControl
_session = requests.Session()
_cached_session = cachecontrol.CacheControl(_session)
_cached_auth_request = AuthRequest(session=_cached_session)


class AIBotIdentityManager:
    def __init__(self, kms_key_path: str = None):
        self._kms_key_path = kms_key_path
        self._kms_client = None

    @property
    def kms_client(self):
        if self._kms_client is None:
            self._kms_client = kms.KeyManagementServiceClient()
        return self._kms_client

    async def _get_kms_key_path(self) -> str:
        if self._kms_key_path:
            return self._kms_key_path
        # Fallback to secret or environment variable
        self._kms_key_path = await get_secret_value("tokenEncryptionKeyPath")
        return self._kms_key_path

    async def encrypt(self, plaintext: str) -> str:
        key_path = await self._get_kms_key_path()
        resp = self.kms_client.encrypt(
            request={"name": key_path, "plaintext": plaintext.encode()}
        )
        return base64.b64encode(resp.ciphertext).decode()

    async def decrypt(self, ciphertext_b64: str) -> str:
        key_path = await self._get_kms_key_path()
        resp = self.kms_client.decrypt(
            request={
                "name": key_path,
                "ciphertext": base64.b64decode(ciphertext_b64),
            }
        )
        return resp.plaintext.decode()

    async def refresh_user_tokens(self, slack_user_id: str) -> str | None:
        """Generates a fresh User ID token on-demand using the Refresh Token and handles rotation."""
        token_data = await get_google_token(slack_user_id)
        if not token_data:
            return None

        encrypted_refresh = token_data.get("refresh_token")
        if not encrypted_refresh:
            return None

        # 1. Decrypt the refresh token
        refresh_token = await self.decrypt(encrypted_refresh)

        # 2. Setup the credentials
        client_id = await get_secret_value("iapClientId")
        client_secret = await get_secret_value("iapClientSecret")

        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
        )

        # 3. Trigger the refresh
        try:
            creds.refresh(AuthRequest())
        except Exception as e:
            logger.error(
                f"Failed to refresh Google token for user {slack_user_id}: {e}"
            )
            return None

        # 4. Handle Refresh Token Rotation
        if creds.refresh_token and creds.refresh_token != refresh_token:
            logger.info(f"Refresh token rotated for user {slack_user_id}")
            token_data["refresh_token"] = await self.encrypt(creds.refresh_token)
            # Remove id_token from Firestore as per requirement
            token_data.pop("id_token", None)
            token_data["updated_at"] = (
                base64.b64encode(os.urandom(8)).decode()
            )  # Placeholder for timestamp if needed, but firestore_api handles it
            await put_google_token(slack_user_id, token_data)

        return creds.id_token


async def verify_iap_jwt(
    jwt_assertion: str, expected_audience: str
) -> dict[str, Any] | None:
    """
    Verifies the JWT assertion from IAP using IAP's public keys.
    See: https://cloud.google.com/iap/docs/signed-headers-howto#verifying_the_jwt_payload
    """
    try:
        # We use verify_token with the IAP certificates URL and a cached request.
        # Adding clock_skew_in_seconds to handle slight time drift.
        payload = id_token.verify_token(
            jwt_assertion,
            _cached_auth_request,
            audience=expected_audience,
            certs_url=IAP_CERTS_URL,
            clock_skew_in_seconds=10,
        )
        return payload
    except Exception as e:
        logger.error(f"IAP JWT Verification failed: {e}")
        # Log specific details if it's a claim issue
        if "audience" in str(e).lower():
            logger.warning(f"Audience mismatch. Expected: {expected_audience}")
        elif "email" in str(e).lower():
            logger.warning(
                "Email claim issue. Token might be missing email claim. Check if --include-email or format=full was used."
            )
        return None


async def exchange_google_code(code: str, redirect_uri: str) -> dict[str, Any]:
    """Exchanges an authorization code for Google tokens."""
    client_id = await get_secret_value("iapClientId")
    client_secret = await get_secret_value("iapClientSecret")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        if resp.status_code != 200:
            logger.error(
                f"Google token exchange failed: {resp.status_code} - {resp.text}"
            )
            resp.raise_for_status()
        return resp.json()


async def refresh_google_id_token(refresh_token: str) -> str | None:
    """Uses a refresh token to get a new Google ID Token."""
    client_id = await get_secret_value("iapClientId")
    client_secret = await get_secret_value("iapClientSecret")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
            },
        )
        if resp.status_code != 200:
            logger.error(f"Failed to refresh Google token: {resp.text}")
            return None

        data = resp.json()
        return data.get("id_token")


def get_google_auth_url(client_id: str, redirect_uri: str, state: str) -> str:
    """Generates the Google OAuth 2.0 authorization URL."""
    from urllib.parse import urlencode

    base_url = "https://accounts.google.com/o/oauth2/v2/auth"
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "consent",  # Ensure we get a refresh token
        "state": state,
    }
    return f"{base_url}?{urlencode(params)}"

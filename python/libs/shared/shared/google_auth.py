import time
import httpx
import logging
from typing import Dict, Any, Optional
from google.oauth2 import id_token
from google.auth.transport import requests
from shared.gcp_api import get_secret_value

logger = logging.getLogger("google-auth")

IAP_CERTS_URL = "https://www.gstatic.com/iap/verify/public_key"

async def verify_iap_jwt(jwt_assertion: str, expected_audience: str) -> Optional[Dict[str, Any]]:
    """
    Verifies the JWT assertion from IAP using IAP's public keys.
    See: https://cloud.google.com/iap/docs/signed-headers-howto#verifying_the_jwt_payload
    """
    try:
        request = requests.Request()
        
        # We use verify_token with the IAP certificates URL.
        # This MUST validate the 'aud' claim to ensure the token was intended for this service.
        payload = id_token.verify_token(
            jwt_assertion,
            request,
            audience=expected_audience,
            certs_url=IAP_CERTS_URL
        )
        return payload
    except Exception as e:
        logger.error(f"IAP JWT Verification failed: {e}")
        # Log specific details if it's a claim issue
        if "audience" in str(e).lower():
            logger.warning(f"Audience mismatch. Expected: {expected_audience}")
        elif "email" in str(e).lower():
            logger.warning(f"Email claim issue. Token might be missing email claim. Check if --include-email or format=full was used.")
        return None

async def exchange_google_code(code: str, redirect_uri: str) -> Dict[str, Any]:
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
                "grant_type": "authorization_code"
            }
        )
        resp.raise_for_status()
        return resp.json()

async def refresh_google_id_token(refresh_token: str) -> Optional[str]:
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
                "grant_type": "refresh_token"
            }
        )
        if resp.status_code != 200:
            logger.error(f"Failed to refresh Google token: {resp.text}")
            return None
        
        data = resp.json()
        return data.get("id_token")

def get_google_auth_url(client_id: str, redirect_uri: str, state: str) -> str:
    """Generates the Google OAuth 2.0 authorization URL."""
    base_url = "https://accounts.google.com/o/oauth2/v2/auth"
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "consent", # Ensure we get a refresh token
        "state": state
    }
    encoded_params = "&".join([f"{k}={v}" for k, v in params.items()])
    return f"{base_url}?{encoded_params}"

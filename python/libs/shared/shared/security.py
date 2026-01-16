import logging
import json
from typing import List, Optional, Dict, Any
from slack_sdk.signature import SignatureVerifier
from .gcp_api import get_secret_value

logger = logging.getLogger(__name__)

# Cache for whitelists
_allowed_team_ids: Optional[List[str]] = None
_allowed_enterprise_ids: Optional[List[str]] = None

async def _get_whitelists():
    global _allowed_team_ids, _allowed_enterprise_ids
    if _allowed_team_ids is None:
        try:
            team_ids_str = await get_secret_value("AIBot", "teamIdsForSearch")
            _allowed_team_ids = [id.strip() for id in team_ids_str.split(",") if id.strip()]
            # For now enterprise IDs are just in env, could move to secret later if needed
            import os
            _allowed_enterprise_ids = [id.strip() for id in os.environ.get("ALLOWED_ENTERPRISE_IDS", "").split(",") if id.strip()]
        except Exception as e:
            logger.error(f"Error loading whitelists: {e}")
            _allowed_team_ids = []
            _allowed_enterprise_ids = []
    return _allowed_team_ids, _allowed_enterprise_ids


async def verify_slack_request(data: bytes, headers: Dict[str, str]) -> bool:
    """Verifies that the request came from Slack using the signing secret."""
    try:
        signing_secret = await get_secret_value("AIBot", "slackSigningSecret")
        verifier = SignatureVerifier(signing_secret)
        if verifier.is_valid_request(data, headers):
            return True
        logger.warning("Invalid Slack signature")
        return False
    except Exception as e:
        logger.error(f"Error during signature verification: {e}")
        return False


async def is_team_authorized(team_id: Optional[str], enterprise_id: Optional[str] = None) -> bool:
    """Verifies if the given team or enterprise is whitelisted."""
    allowed_teams, allowed_enterprises = await _get_whitelists()
    
    if not allowed_teams and not allowed_enterprises:
        logger.error("Security risk: No whitelisted teams or enterprises configured. Denying access.")
        return False

    if team_id in allowed_teams or (enterprise_id and enterprise_id in allowed_enterprises):
        return True
    
    logger.warning(f"Unauthorized access attempt from Team: {team_id}, Enterprise: {enterprise_id}")
    return False


def get_team_id_from_payload(payload: Dict[str, Any]) -> Optional[str]:
    """Extracts team_id from various common Slack payload formats."""
    event = payload.get("event") or {}
    return (
        payload.get("team_id") or 
        payload.get("enterprise_id") or 
        event.get("team") or 
        event.get("user_team") or 
        (payload.get("team") and isinstance(payload.get("team"), dict) and payload.get("team", {}).get("id"))
    )

def get_enterprise_id_from_payload(payload: Dict[str, Any]) -> Optional[str]:
    """Extracts enterprise_id from various common Slack payload formats."""
    event = payload.get("event") or {}
    return payload.get("enterprise_id") or event.get("enterprise")

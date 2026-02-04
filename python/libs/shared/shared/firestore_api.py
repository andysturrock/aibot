import json
from datetime import UTC, datetime, timedelta
from typing import Any

from google.cloud import firestore

HISTORY_COLLECTION = "AIBot_History"
GOOGLE_TOKENS_COLLECTION = "AIBot_Google_Tokens"
TTL_IN_DAYS = 30


async def get_history(
    channel_id: str, thread_ts: str, agent_name: str
) -> list[dict[str, Any]] | None:
    """Gets the history for the given channel and thread id from Firestore."""
    db = firestore.AsyncClient()
    doc_id = f"{channel_id}_{thread_ts}_{agent_name}"
    doc_ref = db.collection(HISTORY_COLLECTION).document(doc_id)
    doc = await doc_ref.get()

    if not doc.exists:
        return None

    data = doc.to_dict()
    if data and "history" in data:
        return json.loads(data["history"])
    return None


async def put_history(
    channel_id: str, thread_ts: str, history: list[dict[str, Any]], agent_name: str
):
    """Saves or overwrites conversation history in Firestore."""
    db = firestore.AsyncClient()
    doc_id = f"{channel_id}_{thread_ts}_{agent_name}"

    expiry_date = datetime.now(UTC) + timedelta(days=TTL_IN_DAYS)

    doc_ref = db.collection(HISTORY_COLLECTION).document(doc_id)
    await doc_ref.set(
        {
            "history": json.dumps(history),
            "channel_id": channel_id,
            "thread_ts": thread_ts,
            "agent_name": agent_name,
            "expiry": expiry_date.isoformat(),
            "updated_at": datetime.now(UTC).isoformat(),
        }
    )


async def delete_history(channel_id: str, thread_ts: str, agent_name: str):
    """Deletes conversation history from Firestore."""
    db = firestore.AsyncClient()
    doc_id = f"{channel_id}_{thread_ts}_{agent_name}"
    await db.collection(HISTORY_COLLECTION).document(doc_id).delete()


async def get_google_token(slack_user_id: str) -> dict[str, Any] | None:
    """Gets the Google token data for the given Slack user ID from Firestore."""
    db = firestore.AsyncClient()
    doc_ref = db.collection(GOOGLE_TOKENS_COLLECTION).document(slack_user_id)
    doc = await doc_ref.get()

    if not doc.exists:
        return None

    return doc.to_dict()


async def put_google_token(slack_user_id: str, token_data: dict[str, Any]):
    """Saves or overwrites a user's Google token data in Firestore."""
    db = firestore.AsyncClient()
    doc_ref = db.collection(GOOGLE_TOKENS_COLLECTION).document(slack_user_id)
    # Ensure ID token is NOT stored as per security requirements
    token_data.pop("id_token", None)
    token_data["slack_id"] = slack_user_id
    token_data["updated_at"] = datetime.now(UTC).isoformat()
    await doc_ref.set(token_data)


async def delete_google_token(slack_user_id: str):
    """Deletes the Google token for a given Slack user from Firestore."""
    db = firestore.AsyncClient()
    await db.collection(GOOGLE_TOKENS_COLLECTION).document(slack_user_id).delete()


async def get_slack_id_by_email(email: str) -> str | None:
    """Looks up a Slack ID by user email using the Google tokens collection."""
    if not email:
        return None

    db = firestore.AsyncClient()
    docs = db.collection(GOOGLE_TOKENS_COLLECTION).where("email", "==", email).stream()
    async for doc in docs:
        return doc.id  # The doc ID is the Slack user ID
    return None

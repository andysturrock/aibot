import json
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional
from google.cloud import firestore

HISTORY_COLLECTION = "AIBot_History"
TOKENS_COLLECTION = "AIBot_Tokens"
TTL_IN_DAYS = 30

async def get_history(channel_id: str, thread_ts: str, agent_name: str) -> Optional[List[Dict[str, Any]]]:
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

async def put_history(channel_id: str, thread_ts: str, history: List[Dict[str, Any]], agent_name: str):
    """Saves or overwrites conversation history in Firestore."""
    db = firestore.AsyncClient()
    doc_id = f"{channel_id}_{thread_ts}_{agent_name}"
    
    expiry_date = datetime.now(timezone.utc) + timedelta(days=TTL_IN_DAYS)
    
    doc_ref = db.collection(HISTORY_COLLECTION).document(doc_id)
    await doc_ref.set({
        "history": json.dumps(history),
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "agent_name": agent_name,
        "expiry": expiry_date.isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    })

async def delete_history(channel_id: str, thread_ts: str, agent_name: str):
    """Deletes conversation history from Firestore."""
    db = firestore.AsyncClient()
    doc_id = f"{channel_id}_{thread_ts}_{agent_name}"
    await db.collection(HISTORY_COLLECTION).document(doc_id).delete()

async def get_access_token(slack_user_id: str) -> Optional[str]:
    """Gets the user access token for the given user id from Firestore."""
    db = firestore.AsyncClient()
    doc_ref = db.collection(TOKENS_COLLECTION).document(slack_user_id)
    doc = await doc_ref.get()
    
    if not doc.exists:
        return None
        
    data = doc.to_dict()
    return data.get("access_token")

async def put_access_token(slack_user_id: str, access_token: str):
    """Saves or overwrites a user's access token in Firestore."""
    db = firestore.AsyncClient()
    doc_ref = db.collection(TOKENS_COLLECTION).document(slack_user_id)
    await doc_ref.set({
        "access_token": access_token,
        "slack_id": slack_user_id,
        "updated_at": datetime.now(timezone.utc).isoformat()
    })

async def delete_access_token(slack_user_id: str):
    """Deletes the access token for a given user from Firestore."""
    db = firestore.AsyncClient()
    await db.collection(TOKENS_COLLECTION).document(slack_user_id).delete()

import os
import json
import logging
import asyncio
import base64
from typing import Dict, Any

from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv

# Import from shared library
from shared import (
    get_secret_value, 
    publish_to_topic, 
    get_history, 
    put_history, 
    get_access_token,
    create_bot_client,
    verify_slack_request,
    is_team_authorized,
    get_team_id_from_payload,
    get_enterprise_id_from_payload
)

# Service specific imports
from agents import create_supervisor_agent
from google.adk.sdk import Runner

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aibot-logic")

# --- Configuration & Constants ---
TOPIC_ID = os.environ.get("TOPIC_ID", "slack-events")

# --- Middleware: Security Verification ---

class SecurityMiddleware(BaseHTTPMiddleware):
    """
    Modular FastAPI (Starlette) middleware to verify Slack signatures and Whitelisting.
    """
    async def dispatch(self, request: Request, call_next):
        # 1. Skip middleware for some routes
        if request.url.path == "/health":
            return await call_next(request)
        
        # 2. Signature Verification & Whitelisting (External /slack/events)
        if request.url.path == "/slack/events" and request.method == "POST":
            # Read body for verification
            body = await request.body()
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                return Response(content="Invalid JSON", status_code=400)
                
            # URL verification doesn't need signature check usually
            if payload.get("type") == "url_verification":
                # We let it through, or handle it here. Handling in route is clearer.
                return await call_next(request)
            
            # Signature Check
            is_valid = await verify_slack_request(body, dict(request.headers))
            if not is_valid:
                return Response(content="Invalid Slack signature", status_code=status.HTTP_401_UNAUTHORIZED)
                
            # Whitelist Check
            team_id = get_team_id_from_payload(payload)
            enterprise_id = get_enterprise_id_from_payload(payload)
            
            if not await is_team_authorized(team_id, enterprise_id):
                logger.warning(f"Unauthorized access attempt from Team: {team_id}")
                # Return 200 to Slack to stop retries, but with descriptive text
                return Response(content="Unauthorized Workspace", status_code=200)

        return await call_next(request)

# --- FastAPI App ---
app = FastAPI(title="AIBot Logic (FastAPI)")
app.add_middleware(SecurityMiddleware)

# --- Slack Helpers ---

async def add_reaction(channel, timestamp, name):
    client = await create_bot_client()
    await client.reactions_add(channel=channel, timestamp=timestamp, name=name)

async def remove_reaction(channel, timestamp, name):
    client = await create_bot_client()
    await client.reactions_remove(channel=channel, timestamp=timestamp, name=name)

async def post_message(channel, text, thread_ts=None):
    client = await create_bot_client()
    await client.chat_postMessage(channel=channel, text=text, thread_ts=thread_ts)

async def handle_home_tab_event(event):
    user_id = event.get("user")
    bot_name = await get_secret_value("AIBot", "botName")
    access_token = await get_access_token(user_id)
    
    blocks = []
    if access_token:
        blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*Successfully Authorised*\n\nYou are logged in as <@{user_id}> to {bot_name}."
                }
            }
        ]
    else:
        auth_url = await get_secret_value("AIBot", "authUrl")
        blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*Authorisation Required*\n\nPlease sign in to allow {bot_name} to search your Slack history."
                }
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Authorize Slack Search"},
                        "url": auth_url,
                        "action_id": "authorize_slack"
                    }
                ]
            }
        ]
    
    client = await create_bot_client()
    await client.views_publish(user_id=user_id, view={"type": "home", "blocks": blocks})

# --- Routes ---

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/slack/events")
async def slack_events(request: Request):
    payload = await request.json()
    
    # URL Verification (Challenge)
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}
    
    # Core Logic: Publish to Pub/Sub (Already verified by Middleware)
    await publish_to_topic(TOPIC_ID, json.dumps(payload))
    return Response(content="OK", status_code=200)

@app.post("/pubsub/worker")
async def pubsub_worker(request: Request):
    envelope = await request.json()
    if not envelope or "message" not in envelope:
        raise HTTPException(status_code=400, detail="Bad Request")
    
    message = envelope["message"]
    data = base64.b64decode(message["data"]).decode("utf-8")
    payload = json.loads(data)
    
    event_type = payload.get("type")
    event = payload.get("event") or {}
    
    # Dispatching
    if event_type == "event_callback":
        inner_type = event.get("type")
        
        if inner_type == "app_mention":
            channel_id = event.get("channel")
            thread_ts = event.get("ts")
            text = event.get("text")
            
            # 1. Add reaction
            await add_reaction(channel_id, thread_ts, "eyes")
            
            # 2. Run Agent
            try:
                # Load history
                history = await get_history(channel_id, thread_ts, "supervisor") or []
                
                supervisor = await create_supervisor_agent()
                runner = Runner(agent=supervisor, app_name="AIBot")
                
                # Pre-process text (remove bot mention)
                bot_info = await (await create_bot_client()).auth_test()
                bot_user_id = bot_info["user_id"]
                prompt = text.replace(f"<@{bot_user_id}>", "").strip()
                
                # Execute agent flow
                result = await runner.run(prompt, history=history)
                
                # Format response
                final_response = result
                if isinstance(result, dict) and "answer" in result:
                    final_response = result["answer"]
                    if result.get("attributions"):
                        final_response += "\n\n*Sources:*\n" + "\n".join(result["attributions"])
                
                await post_message(channel_id, final_response, thread_ts=thread_ts)
                
                # 3. Remove reaction
                await remove_reaction(channel_id, thread_ts, "eyes")
                
                # 4. Save history
                new_history = history + [
                    {"role": "user", "parts": [{"text": prompt}]},
                    {"role": "model", "parts": [{"text": final_response}]}
                ]
                await put_history(channel_id, thread_ts, new_history, "supervisor")
                
            except Exception as e:
                logger.exception("Error in processing bot logic")
                await post_message(channel_id, f"Sorry, I encountered an error: {str(e)}", thread_ts=thread_ts)
                await remove_reaction(channel_id, thread_ts, "eyes")

        elif inner_type == "app_home_opened":
            await handle_home_tab_event(event)

    return Response(content="OK", status_code=200)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

import os
import json
import logging
import asyncio
import base64
import traceback
from typing import Dict, Any

from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv

# Import from shared library submodules
from shared.logging import setup_logging
from shared.gcp_api import get_secret_value, publish_to_topic
from shared.firestore_api import get_history, put_history, get_google_token, put_google_token
from shared.google_auth import get_google_auth_url, exchange_google_code
from shared.slack_api import create_bot_client
from shared.security import (
    verify_slack_request,
    is_team_authorized,
    get_team_id_from_payload,
    get_enterprise_id_from_payload
)

# Service specific imports
from agents import create_supervisor_agent
from google.adk import Runner
from google.adk.runners import InMemorySessionService
from google.adk.events.event import Event
from google.genai import types

load_dotenv()
setup_logging(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("aibot-logic")

# --- Configuration & Constants ---
TOPIC_ID = os.environ.get("TOPIC_ID", "slack-events")

# --- Middleware: Security Verification ---

class SecurityMiddleware(BaseHTTPMiddleware):
    """
    Modular FastAPI (Starlette) middleware to verify Slack signatures and Whitelisting.
    """
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method
        logger.debug(f"Middleware processing {method} {path}")

        if path == "/health":
            return await call_next(request)

        # 403 on unauthenticated access to non-app paths
        # Differentiation based on service role (Webhook vs Logic Worker)
        service_name = os.environ.get("K_SERVICE", "aibot-logic")
        
        allowed_paths = []
        if service_name == "aibot-webhook":
            allowed_paths = [
                "/slack/events", 
                "/slack/interactivity", 
                "/slack/install", 
                "/slack/oauth-redirect"
            ]
        elif service_name == "aibot-logic":
            allowed_paths = ["/pubsub/worker"]
        
        if path not in allowed_paths and not path.startswith("/auth/"):
             logger.warning(f"Stealth security: Unauthorized access attempt to {path} on service {service_name} from {request.client.host}")
             return JSONResponse(status_code=403, content={"detail": "Forbidden"})

        payload = None
        if path in ["/slack/events", "/slack/interactivity"] and method == "POST":
            # Read body for verification
            body = await request.body()
            
            # Signature Check
            is_valid = await verify_slack_request(body, dict(request.headers))
            if not is_valid:
                return Response(content="Invalid Slack signature", status_code=status.HTTP_401_UNAUTHORIZED)

            # Extract payload for whitelisting
            payload = {}
            content_type = request.headers.get("content-type", "")
            
            if "application/json" in content_type:
                payload = json.loads(body)
            elif "application/x-www-form-urlencoded" in content_type:
                # Interactivity sends JSON inside a 'payload' form field
                from urllib.parse import parse_qs
                form_data = parse_qs(body.decode("utf-8"))
                if "payload" in form_data:
                    payload = json.loads(form_data["payload"][0])

            # Whitelist Check
            if payload:
                # URL verification doesn't need whitelist check (it's global for the app)
                if payload.get("type") == "url_verification":
                    return await call_next(request)
                    
                team_id = get_team_id_from_payload(payload)
                enterprise_id = get_enterprise_id_from_payload(payload)
                
                if not await is_team_authorized(team_id, enterprise_id):
                    logger.warning(f"Unauthorized access attempt from Team: {team_id}, Enterprise: {enterprise_id} at {path}")
                    return Response(content="Unauthorized Workspace", status_code=200)

        try:
            response = await call_next(request)
            logger.debug(f"Path {path} returned {response.status_code}")
            return response
        except Exception as e:
            logger.error(f"Error processing path {path}", extra={
                "path": path,
                "method": method,
                "exception": str(e)
            }, exc_info=True)
            raise

# --- FastAPI App ---
app = FastAPI(
    title="AIBot Logic (FastAPI)",
    docs_url=None,
    redoc_url=None,
    openapi_url=None
)
app.add_middleware(SecurityMiddleware)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception in FastAPI", extra={
        "path": request.url.path,
        "method": request.method,
        "exception": str(exc),
        "traceback": traceback.format_exc()
    })
    return JSONResponse(
        status_code=500,
        content={"message": f"Internal Server Error: {str(exc)}"}
    )

@app.on_event("startup")
async def startup_event():
    # Log all registered routes for debugging 404s
    for route in app.routes:
        logger.info(f"Registered route: {route.path} [{','.join(route.methods)}]")

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
    bot_name = await get_secret_value("botName")
    google_token_data = await get_google_token(user_id)
    
    blocks = []
    if google_token_data:
        email = google_token_data.get("email", "Unknown")
        blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*Successfully Authorised*\n\nYou are signed in as *{email}* to {bot_name}."
                }
            }
        ]
    else:
        # Generate Auth URL
        custom_fqdn = await get_secret_value("customFqdn")
        if not custom_fqdn:
            logger.error("Configuration Error: 'customFqdn' is missing from secrets configuration.")
            blocks = [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "🔴 *Configuration Error*\n\nI am unable to initiate login because the application is not fully configured (missing FQDN). Please contact your administrator or support."
                    }
                }
            ]
        else:
            redirect_uri = f"https://{custom_fqdn}/auth/callback/google"
            client_id = await get_secret_value("iapClientId")
            
            auth_url = get_google_auth_url(client_id, redirect_uri, state=user_id)
            
            blocks = [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Google Login Required*\n\nPlease sign in with Google to allow {bot_name} to search your Slack history and access protected resources."
                    }
                },
                {
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": {"type": "plain_text", "text": "Sign in with Google"},
                            "url": auth_url,
                            "style": "primary",
                            "action_id": "authorize_google"
                        }
                    ]
                }
            ]
    
    client = await create_bot_client()
    await client.views_publish(user_id=user_id, view={"type": "home", "blocks": blocks})

# --- Service Role Identification ---
service_role = os.environ.get("K_SERVICE", "aibot-logic")

# --- Routes ---

@app.get("/health")
async def health():
    return {"status": "ok"}

if service_role == "aibot-webhook":
    logger.info("Registering Webhook routes")
    
    @app.post("/slack/events")
    async def slack_events(request: Request):
        payload = await request.json()
        
        # URL Verification (Challenge)
        if payload.get("type") == "url_verification":
            return {"challenge": payload.get("challenge")}
        
        # Core Logic: Publish to Pub/Sub (Already verified by Middleware)
        # Check if it's a message we should acknowledge with eyes
        event = payload.get("event", {})
        inner_type = event.get("type")
        channel_id = event.get("channel")
        message_ts = event.get("ts")
        
        # We handle app_mentions and non-bot DM messages
        should_react = inner_type == "app_mention" or (
            inner_type == "message" and 
            event.get("channel_type") == "im" and 
            not event.get("bot_id") and 
            not event.get("subtype") == "bot_message"
        )
        
        if should_react and channel_id and message_ts:
            try:
                await add_reaction(channel_id, message_ts, "eyes")
            except Exception:
                logger.exception("Failed to add eyes reaction")

        await publish_to_topic(TOPIC_ID, json.dumps(payload))
        return Response(content="OK", status_code=200)

    @app.post("/slack/interactivity")
    async def slack_interactivity(request: Request):
        # Interactivity payloads are URL-encoded form data
        form_data = await request.form()
        payload_str = form_data.get("payload")
        if not payload_str:
            return Response(content="Missing payload", status_code=400)
            
        payload = json.loads(payload_str)
        
        # Core Logic: Publish to Pub/Sub
        await publish_to_topic(TOPIC_ID, json.dumps(payload))
        return Response(content="OK", status_code=200)

    @app.get("/auth/login/google")
    async def google_login(request: Request):
        # This is a convenience endpoint if someone goes there directly
        # But usually they click the button in Slack
        user_id = "manual_login" # State should ideally pass through
        custom_fqdn = os.environ.get("CUSTOM_FQDN")
        redirect_uri = f"https://{custom_fqdn}/auth/callback/google"
        client_id = await get_secret_value("iapClientId")
        auth_url = get_google_auth_url(client_id, redirect_uri, state=user_id)
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=auth_url)

    @app.get("/auth/callback/google")
    async def google_callback(code: str, state: str = None):
        """
        Handles the Google OAuth callback, exchanges code for tokens, 
        and stores in Firestore.
        """
        try:
            custom_fqdn = os.environ.get("CUSTOM_FQDN")
            redirect_uri = f"https://{custom_fqdn}/auth/callback/google"
            
            # 1. Exchange code for tokens
            tokens = await exchange_google_code(code, redirect_uri)
            
            # 2. Decode ID Token to get email (for verification/display)
            import jwt # Use PyJWT or similar to decode without verification if we trust Google or use our library
            id_token_payload = jwt.decode(tokens["id_token"], options={"verify_signature": False})
            email = id_token_payload.get("email")
            
            # 3. Store in Firestore
            # state contains the Slack user_id if initiated from Slack
            slack_user_id = state if state and state != "manual_login" else "unknown"
            
            await put_google_token(slack_user_id, {
                "id_token": tokens.get("id_token"),
                "refresh_token": tokens.get("refresh_token"),
                "email": email,
                "expires_at": time.time() + tokens.get("expires_in", 3600)
            })
            
            # 4. Success Page
            return Response(
                content=f"<h1>Success!</h1><p>You are now signed in as <b>{email}</b>. You can close this window and return to Slack.</p>",
                media_type="text/html"
            )
        except Exception as e:
            logger.exception("Google OAuth callback failed")
            return Response(content=f"Error: {str(e)}", status_code=500)

    @app.get("/slack/oauth-redirect")
    async def slack_oauth_redirect(code: str):
        # We KEEP this for Slack Bot installation if needed, 
        # but user authentication is now via Google.
        return Response(content="Slack Bot Auth successful. Please use 'Sign in with Google' on the Home tab for search access.", status_code=200)

elif service_role == "aibot-logic":
    logger.info("Registering Logic Worker routes")

    @app.post("/pubsub/worker")
    async def pubsub_worker(request: Request):
        envelope = await request.json()
        logger.info(f"Received Pub/Sub envelope: {json.dumps(envelope)}")
        if not envelope or "message" not in envelope:
            logger.error("Missing 'message' in Pub/Sub envelope")
            raise HTTPException(status_code=400, detail="Bad Request")
        
        message = envelope["message"]
        data = base64.b64decode(message["data"]).decode("utf-8")
        payload = json.loads(data)
        logger.info(f"Pub/Sub Payload: {json.dumps(payload)}")
        
        event_type = payload.get("type")
        event = payload.get("event") or {}
        
        # Dispatching
        if event_type == "event_callback":
            inner_type = event.get("type")
            logger.info(f"Processing event_callback: {inner_type}")
            
            # Check if this is a message we should respond to
            should_handle = False
            if inner_type == "app_mention":
                should_handle = True
            elif inner_type == "message":
                # Handle Direct Messages (IMs)
                if event.get("channel_type") == "im" and not event.get("bot_id"):
                    should_handle = True
                # Optional: Support group messages if bot is mentioned by name, 
                # but app_mention usually covers this if @bot is used.
            
            if should_handle:
                logger.info(f"Handling {inner_type} event")
                channel_id = event.get("channel")
                message_ts = event.get("ts")
                thread_ts = event.get("thread_ts") or message_ts
                text = event.get("text")
                
                # Check for bot loops just in case
                if event.get("bot_id") or event.get("subtype") == "bot_message":
                    logger.info("Ignoring bot message")
                    return Response(content="OK", status_code=200)
                
                # 1. Swap eyes for thinking face
                try:
                    await remove_reaction(channel_id, message_ts, "eyes")
                except Exception:
                    pass # Might not have been added or already removed
                
                try:
                    await add_reaction(channel_id, message_ts, "thinking_face")
                except Exception as e:
                    if "already_reacted" not in str(e):
                        logger.warning(f"Failed to add thinking_face reaction: {e}")
                
                # 2. Run Agent
                try:
                    # Load history
                    history = await get_history(channel_id, thread_ts, "supervisor") or []
                    
                    # Create Supervisor Agent with Slack User ID
                    user_id = event.get("user")
                    supervisor = await create_supervisor_agent(slack_user_id=user_id)
                    session_service = InMemorySessionService()
                    session = await session_service.create_session(
                        app_name="AIBot",
                        user_id=user_id,
                        session_id=thread_ts
                    )
                    
                    # Seed history from Firestore
                    logger.info(f"Seeding history for session {thread_ts} with {len(history)} items")
                    for i, item in enumerate(history):
                        role = item.get("role")
                        # Join parts to form a single text string per turn
                        content_text = " ".join([p.get("text", "") for p in item.get("parts", []) if p.get("text")])
                        
                        content = types.Content(
                            role=role,
                            parts=[types.Part(text=content_text)]
                        )
                        # ADK filters by author match. 'user' is fixed, model author must match agent name.
                        author = "user" if role == "user" else supervisor.name
                        
                        await session_service.append_event(
                            session=session,
                            event=Event(
                                author=author,
                                content=content,
                                invocation_id=f"hist_{i//2}" # Group pairs into virtual invocations
                            )
                        )
                    
                    runner = Runner(
                        agent=supervisor, 
                        app_name="AIBot",
                        session_service=session_service
                    )
                    
                    # Pre-process text (remove bot mention)
                    bot_info = await (await create_bot_client()).auth_test()
                    bot_user_id = bot_info["user_id"]
                    prompt = text.replace(f"<@{bot_user_id}>", "").strip()
                    
                    # Execute agent flow
                    # Convert history to Adk Event objects if necessary, or just use run_async
                    # For now, let's use run_async with the new message
                    new_message = types.Content(role="user", parts=[types.Part(text=prompt)])
                    
                    responses = []
                    async for event in runner.run_async(
                        user_id=user_id,
                        session_id=thread_ts,
                        new_message=new_message
                    ):
                        if event.content and event.content.parts:
                            for part in event.content.parts:
                                if part.text:
                                    responses.append(part.text)
                    
                    final_response = "".join(responses).strip()
                    
                    # Try to parse as JSON (Supervisor format)
                    try:
                        # Sometimes the model wraps JSON in markdown blocks
                        data_str = final_response
                        if data_str.startswith("```"):
                            # Simple markdown block extraction
                            lines = data_str.split("\n")
                            if lines[0].startswith("```json"):
                                data_str = "\n".join(lines[1:-1])
                            elif lines[0].startswith("```"):
                                data_str = "\n".join(lines[1:-1])

                        data = json.loads(data_str)
                        if isinstance(data, dict) and "answer" in data:
                            final_text = data["answer"]
                            if data.get("attributions"):
                                final_text += "\n\n*Sources:*\n"
                                for attr in data["attributions"]:
                                    title = attr.get("title", "Link")
                                    uri = attr.get("uri", "#")
                                    final_text += f"• <{uri}|{title}>\n"
                            final_response = final_text
                    except Exception:
                        logger.debug("Response was not valid JSON, using raw text")

                    if not final_response:
                        final_response = "I couldn't generate a response."
                    
                    await post_message(channel_id, final_response, thread_ts=thread_ts)
                    
                    # 3. Save history is handled by Runner if using a real session service, 
                    # but we are using InMemorySessionService so we might still want manual persistence 
                    # if we want to survive worker restarts.
                    
                    # 4. Save history
                    new_history = history + [
                        {"role": "user", "parts": [{"text": prompt}]},
                        {"role": "model", "parts": [{"text": final_response}]}
                    ]
                    await put_history(channel_id, thread_ts, new_history, "supervisor")
                    
                except Exception as e:
                    logger.exception("Error in processing bot logic")
                    await post_message(channel_id, f"Sorry, I encountered an error: {str(e)}", thread_ts=thread_ts)
                finally:
                    # 3. Cleanup thinking face
                    try:
                        await remove_reaction(channel_id, message_ts, "thinking_face")
                    except Exception:
                        pass

            elif inner_type == "app_home_opened":
                await handle_home_tab_event(event)

        return Response(content="OK", status_code=200)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)

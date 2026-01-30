import asyncio
import base64
import json
import logging
import os
import random
import time
import traceback
import uuid
from contextlib import asynccontextmanager

# Service specific imports
from agents import create_supervisor_agent
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from google.adk import Runner
from google.adk.events.event import Event
from google.adk.runners import InMemorySessionService
from google.auth.transport import requests as auth_requests
from google.genai import types
from google.oauth2 import id_token
from shared.firestore_api import (
    get_google_token,
    get_history,
    put_google_token,
    put_history,
)
from shared.gcp_api import get_secret_value, publish_to_topic
from shared.google_auth import exchange_google_code, get_google_auth_url

# Import from shared library submodules
from shared.logging import setup_logging
from shared.security import (
    get_enterprise_id_from_payload,
    get_team_id_from_payload,
    is_team_authorized,
    verify_slack_request,
)
from shared.slack_api import create_bot_client
from starlette.middleware.base import BaseHTTPMiddleware

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
                "/slack/oauth-redirect",
            ]
        elif service_name == "aibot-logic":
            allowed_paths = ["/pubsub/worker"]
        elif os.environ.get("ENV") == "test" or service_name == "test-service":
            # Allow everything in tests to avoid 403 blocks during component tests
            allowed_paths = [
                "/health",
                "/slack/events",
                "/slack/interactivity",
                "/slack/install",
                "/slack/oauth-redirect",
                "/pubsub/worker",
            ]

        if path not in allowed_paths and not path.startswith("/auth/"):
            logger.warning(
                f"Stealth security: Unauthorized access attempt to {path} on service {service_name} from {request.client.host}"
            )
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})

        payload = None
        if path in ["/slack/events", "/slack/interactivity"] and method == "POST":
            # Read body for verification
            body = await request.body()

            # Signature Check
            is_valid = await verify_slack_request(body, dict(request.headers))
            if not is_valid:
                logger.warning(
                    f"Rejected: Invalid Slack signature. Path: {path}, Method: {method}"
                )
                return Response(
                    content="Invalid Slack signature",
                    status_code=status.HTTP_401_UNAUTHORIZED,
                )

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
                    logger.warning(
                        f"Rejected: Unauthorized access attempt from Team: {team_id}, Enterprise: {enterprise_id}. Path: {path}"
                    )
                    return Response(content="Unauthorized Workspace", status_code=200)

        try:
            response = await call_next(request)
            logger.debug(f"Path {path} returned {response.status_code}")
            return response
        except Exception as e:
            logger.error(
                f"Error processing path {path}",
                extra={"path": path, "method": method, "exception": str(e)},
                exc_info=True,
            )
            raise


# --- Lifespan Handler ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Log all registered routes for debugging 404s
    for route in app.routes:
        logger.info(f"Registered route: {route.path} [{','.join(route.methods)}]")
    yield


# --- FastAPI App ---
app = FastAPI(
    title="AIBot Logic (FastAPI)",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
app.add_middleware(SecurityMiddleware)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    request_id = str(uuid.uuid4())
    logger.error(
        f"Unhandled exception in FastAPI [Request ID: {request_id}]",
        extra={
            "request_id": request_id,
            "path": request.url.path,
            "method": request.method,
            "exception": str(exc),
            "traceback": traceback.format_exc(),
        },
    )
    return JSONResponse(
        status_code=500,
        content={"message": "Internal Server Error", "request_id": request_id},
    )


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


async def post_ephemeral(channel, user, text, thread_ts=None):
    client = await create_bot_client()
    await client.chat_postEphemeral(
        channel=channel, user=user, text=text, thread_ts=thread_ts
    )


async def handle_home_tab_event(event):
    from datetime import datetime

    import pytz

    user_id = event.get("user")
    bot_name = await get_secret_value("botName")
    google_token_data = await get_google_token(user_id)

    # Get current time for diagnostics
    now = datetime.now(pytz.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    logger.info(f"Rendering Home tab for user {user_id} at {now}")

    blocks = [
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"🕒 *Last Refreshed:* {now}"}],
        },
        {"type": "divider"},
    ]
    if google_token_data:
        email = google_token_data.get("email", "Unknown")
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*Successfully Authorised*\n\nYou are signed in as *{email}* to {bot_name}.",
                },
            }
        )
    else:
        # Generate Auth URL
        custom_fqdn = await get_secret_value("customFqdn")
        if not custom_fqdn:
            logger.error(
                "Configuration Error: 'customFqdn' is missing from secrets configuration."
            )
            blocks.append(
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "🔴 *Configuration Error*\n\nI am unable to initiate login because the application is not fully configured (missing FQDN). Please contact your administrator or support.",
                    },
                }
            )
        else:
            redirect_uri = f"https://{custom_fqdn}/auth/callback"
            client_id = await get_secret_value("iapClientId")

            auth_url = get_google_auth_url(client_id, redirect_uri, state=user_id)
            logger.info(f"Generated Google Auth URL for user {user_id}: {auth_url}")
            logger.debug(f"Using Redirect URI: {redirect_uri}")

            blocks.extend(
                [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": f"*Google Login Required*\n\nPlease sign in with Google to allow {bot_name} to search your Slack history and access protected resources.",
                        },
                    },
                    {
                        "type": "actions",
                        "elements": [
                            {
                                "type": "button",
                                "text": {
                                    "type": "plain_text",
                                    "text": "Sign in with Google",
                                },
                                "url": auth_url,
                                "style": "primary",
                                "action_id": "authorize_google",
                            }
                        ],
                    },
                ]
            )

    client = await create_bot_client()
    response = await client.views_publish(
        user_id=user_id, view={"type": "home", "blocks": blocks}
    )
    if response["ok"]:
        logger.info(f"Successfully published Home tab for user {user_id}")
    else:
        logger.error(
            f"Failed to publish Home tab for user {user_id}: {response['error']}"
        )


# --- Service Role Identification ---
service_role = os.environ.get("K_SERVICE", "aibot-logic")

# --- Routes ---


@app.get("/health")
async def health():
    return {"status": "ok"}


# --- Background Tasks ---


async def keep_alive_status_updates(channel_id: str, user_id: str, thread_ts: str):
    """Periodically sends ephemeral messages to keep the user informed."""
    messages = [
        "Polishing the dilithium crystals...",
        "Consulting the oracle (and maybe some Slack archives)...",
        "Reticulating splines and searching for answers...",
        "Herding digital cats into a coherent response...",
        "Brewing a fresh pot of data tea while I search...",
        "Teaching the hamsters to run faster on the search wheel...",
        "Decoding the secret language of Slack threads...",
        "Engaging warp drive on the search engine...",
        "Calculating the ultimate answer to life, the universe, and everything...",
        "Dusting off the ancient scrolls of knowledge...",
        "Optimizing the flux capacitor for maximum research speed...",
        "Bending the space-time continuum to find that message...",
        "Asking the rubber ducks for their expert opinion...",
        "Calibrating the resonance cascades...",
        "Feeding the internet trolls so they leave our search alone...",
        "Spinning up the infinite monkey theorem...",
        "Aligning the planets for better search relevance...",
        "Defragmenting the collective consciousness...",
        "Sifting through the digital sands of time...",
        "Reversing the polarity of the neutron flow...",
    ]
    random.shuffle(messages)
    idx = 0
    try:
        while True:
            await asyncio.sleep(15)
            msg = messages[idx % len(messages)]
            try:
                await post_ephemeral(channel_id, user_id, msg, thread_ts=thread_ts)
            except Exception as e:
                logger.warning(f"Failed to send keep-alive ephemeral: {e}")
            idx += 1
    except asyncio.CancelledError:
        logger.debug("Keep-alive task cancelled.")


if service_role in ["aibot-webhook", "test-service"]:
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
            inner_type == "message"
            and event.get("channel_type") == "im"
            and not event.get("bot_id")
            and not event.get("subtype")
        )

        if should_react and channel_id and message_ts:
            try:
                await add_reaction(channel_id, message_ts, "eyes")
            except Exception:
                logger.warning("Failed to add eyes reaction")

        # For non-challenge events, we just publish to Pub/Sub and return 200
        # This keeps the webhook response time very low to satisfy Slack's 3s limit.
        try:
            # We add the user who triggered it to the payload if available
            # to help the worker identify them without another API call.
            at_user = None
            if payload.get("event"):
                at_user = payload["event"].get("user") or payload["event"].get(
                    "user_id"
                )

            if at_user:
                payload["at_user"] = at_user

            await publish_to_topic(TOPIC_ID, json.dumps(payload))
            return Response(content="OK", status_code=200)
        except Exception as e:
            logger.exception("Failed to publish to Pub/Sub")
            return Response(content=f"Error: {str(e)}", status_code=500)

    @app.get("/auth/login")
    async def login(slack_user_id: str):
        # 1. Check if user already has a valid refresh token
        token_data = await get_google_token(slack_user_id)
        if token_data and token_data.get("refresh_token"):
            return Response(
                content="<h1>Already Authenticated</h1><p>You are already signed in to Google. You can close this window.</p>",
                media_type="text/html",
            )

        # 2. Generate Google Auth URL
        # We pass slack_user_id in state to tie the tokens back to them in the callback
        state = json.dumps({"slack_user_id": slack_user_id})

        # We need to use the actual FQDN for the redirect URI
        custom_fqdn = await get_secret_value("customFqdn")
        if not custom_fqdn:
            return Response(content="Error: customFqdn not configured", status_code=500)

        redirect_uri = f"https://{custom_fqdn}/auth/callback"
        logger.debug(f"Using Redirect URI: {redirect_uri}")

        client_id = await get_secret_value("iapClientId")
        auth_url = get_google_auth_url(client_id, redirect_uri, state=state)
        return RedirectResponse(url=auth_url)

    @app.get("/auth/callback")
    async def callback(request: Request):
        code = request.query_params.get("code")
        state_str = request.query_params.get("state")

        if not code or not state_str:
            raise HTTPException(status_code=400, detail="Missing code or state")

        try:
            state = json.loads(state_str)
            slack_user_id = state.get("slack_user_id")

            # 1. Exchange code for tokens
            custom_fqdn = await get_secret_value("customFqdn")
            if not custom_fqdn:
                return Response(
                    content="Error: customFqdn secret missing", status_code=500
                )

            redirect_uri = f"https://{custom_fqdn}/auth/callback"
            logger.debug(f"Using Redirect URI: {redirect_uri}")

            tokens = await exchange_google_code(code, redirect_uri)

            if not tokens or not tokens.get("id_token"):
                return Response(
                    content="<h1>Authentication Failed</h1><p>Could not retrieve ID token from Google.</p>",
                    status_code=400,
                    media_type="text/html",
                )

            # 2. Verify and Decode ID Token
            try:
                client_id = await get_secret_value("iapClientId")
                # verify_oauth2_token handles signature, expiry, and audience verification.
                id_token_payload = id_token.verify_oauth2_token(
                    tokens.get("id_token"), auth_requests.Request(), client_id
                )
                email = id_token_payload.get("email", "Unknown")
            except Exception as verify_err:
                logger.error(f"Failed to verify Google ID token: {verify_err}")
                return Response(
                    content=f"<h1>Authentication Failed</h1><p>Google token verification failed: {str(verify_err)}</p>",
                    status_code=401,
                    media_type="text/html",
                )

            # 3. Store tokens in Firestore
            # The put_google_token function expects a dictionary with specific keys
            await put_google_token(
                slack_user_id,
                {
                    "id_token": tokens.get("id_token"),
                    "refresh_token": tokens.get("refresh_token"),
                    "email": email,
                    "expires_at": time.time() + tokens.get("expires_in", 3600),
                },
            )

            logger.info(
                f"Successfully authenticated Google user: {email} (Slack User ID: {slack_user_id})"
            )

            return Response(
                content=f"<h1>Success!</h1><p>You are now signed in as <b>{email}</b>. You can close this window and return to Slack.</p>",
                media_type="text/html",
            )
        except Exception as e:
            logger.exception("Google OAuth callback failed")
            return Response(content=f"Error: {str(e)}", status_code=500)

    @app.get("/slack/oauth-redirect")
    async def slack_oauth_redirect(code: str):
        # We KEEP this for Slack Bot installation if needed,
        # but user authentication is now via Google.
        return Response(
            content="Slack Bot Auth successful. Please use 'Sign in with Google' on the Home tab for search access.",
            status_code=200,
        )


if service_role in ["aibot-logic", "test-service"]:
    logger.info("Registering Logic Worker routes")

    @app.post("/pubsub/worker")
    async def pubsub_worker(request: Request):
        keep_alive_task = None
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
                # Ignore messages with subtypes (like message_changed) and bot messages
                if (
                    event.get("channel_type") == "im"
                    and not event.get("bot_id")
                    and not event.get("subtype")
                ):
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
                    pass  # Might not have been added or already removed

                try:
                    await add_reaction(channel_id, message_ts, "thinking_face")
                except Exception as e:
                    if "already_reacted" not in str(e):
                        logger.warning(f"Failed to add thinking_face reaction: {e}")

                # 2. Run Agent
                try:
                    # Load history
                    history = (
                        await get_history(channel_id, thread_ts, "supervisor") or []
                    )

                    # Create Supervisor Agent with Slack User ID
                    # Slack events can have 'user' or 'user_id' depending on the type
                    user_id = (
                        event.get("user")
                        or event.get("user_id")
                        or payload.get("at_user")
                    )
                    logger.info(
                        f"Extracted user_id: {user_id} from event_type: {inner_type}"
                    )

                    if not user_id:
                        logger.error(
                            f"Failed to extract user_id from payload: {json.dumps(payload)}"
                        )
                        await post_message(
                            channel_id,
                            "Sorry, I couldn't identify your Slack user ID. This might be due to an unsupported event type.",
                            thread_ts=thread_ts,
                        )
                        return Response(
                            content="User identification failed", status_code=200
                        )

                    supervisor = await create_supervisor_agent(slack_user_id=user_id)
                    session_service = InMemorySessionService()
                    session = await session_service.create_session(
                        app_name="AIBot", user_id=user_id, session_id=thread_ts
                    )

                    # Seed history from Firestore
                    logger.info(
                        f"Seeding history for session {thread_ts} with {len(history)} items"
                    )
                    for i, item in enumerate(history):
                        role = item.get("role")
                        # Join parts to form a single text string per turn
                        content_text = " ".join(
                            [
                                p.get("text", "")
                                for p in item.get("parts", [])
                                if p.get("text")
                            ]
                        )

                        content = types.Content(
                            role=role, parts=[types.Part(text=content_text)]
                        )
                        # ADK filters by author match. 'user' is fixed, model author must match agent name.
                        author = "user" if role == "user" else supervisor.name

                        await session_service.append_event(
                            session=session,
                            event=Event(
                                author=author,
                                content=content,
                                invocation_id=f"hist_{i//2}",  # Group pairs into virtual invocations
                            ),
                        )

                    runner = Runner(
                        agent=supervisor,
                        app_name="AIBot",
                        session_service=session_service,
                    )

                    # Start keep-alive background task
                    if user_id:
                        keep_alive_task = asyncio.create_task(
                            keep_alive_status_updates(channel_id, user_id, thread_ts)
                        )

                    # Pre-process text (remove bot mention)
                    bot_info = await (await create_bot_client()).auth_test()
                    bot_user_id = bot_info["user_id"]
                    prompt = text.replace(f"<@{bot_user_id}>", "").strip()

                    # Execute agent flow
                    # Convert history to Adk Event objects if necessary, or just use run_async
                    # For now, let's use run_async with the new message
                    new_message = types.Content(
                        role="user", parts=[types.Part(text=prompt)]
                    )

                    responses = []
                    async for event in runner.run_async(
                        user_id=user_id, session_id=thread_ts, new_message=new_message
                    ):
                        if event.content and event.content.parts:
                            for part in event.content.parts:
                                if part.text:
                                    responses.append(part.text)

                    final_response = "".join(responses).strip()

                    if not final_response:
                        final_response = "I couldn't generate a response."

                    await post_message(channel_id, final_response, thread_ts=thread_ts)

                    # 3. Save history is handled by Runner if using a real session service,
                    # but we are using InMemorySessionService so we might still want manual persistence
                    # if we want to survive worker restarts.

                    # 4. Save history
                    new_history = history + [
                        {"role": "user", "parts": [{"text": prompt}]},
                        {"role": "model", "parts": [{"text": final_response}]},
                    ]
                    await put_history(channel_id, thread_ts, new_history, "supervisor")

                except Exception as e:
                    logger.exception("Error in processing bot logic")
                    await post_message(
                        channel_id,
                        f"Sorry, I encountered an error: {str(e)}",
                        thread_ts=thread_ts,
                    )
                finally:
                    # Cancel keep-alive task
                    if keep_alive_task:
                        keep_alive_task.cancel()
                        try:
                            await keep_alive_task
                        except asyncio.CancelledError:
                            pass

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

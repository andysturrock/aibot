import os
import json
import logging
import asyncio
from typing import Optional
from google.cloud import secretmanager_v1, pubsub_v1
import google.auth
from google.auth.transport.requests import Request
import google.oauth2.id_token

logger = logging.getLogger(__name__)

async def _access_secret(project_id, secret_name):
    """Internal helper to fetch and parse JSON secret."""
    client = secretmanager_v1.SecretManagerServiceAsyncClient()
    name = f"projects/{project_id}/secrets/{secret_name}/versions/latest"
    try:
        response = await client.access_secret_version(request={"name": name})
        payload = response.payload.data.decode("UTF-8")
        return json.loads(payload)
    except Exception as e:
        logger.error(f"Failed to access secret {secret_name}: {e}", exc_info=True)
        return None

async def get_secret_value(secret_key: str) -> str:
    """Retrieves a secret from GCP Secret Manager (Async). 
    Checks AIBot-shared-config first, then falls back to [service]-config.
    """
    # 1. Check local environment variables first
    env_secret = os.environ.get(secret_key)
    if env_secret:
        return env_secret

    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project_id:
        import google.auth
        _, project_id = google.auth.default()

    # 2. Check AIBot-shared-config
    shared_secrets = await _access_secret(project_id, "AIBot-shared-config")
    if shared_secrets and secret_key in shared_secrets:
        return shared_secrets[secret_key]

    # 3. Fallback to Service-Specific config
    service_name = os.environ.get("K_SERVICE")
    if service_name:
        secret_name = f"{service_name}-config"
        service_secrets = await _access_secret(project_id, secret_name)
        if service_secrets and secret_key in service_secrets:
            return service_secrets[secret_key]

    logger.warning(f"Secret key '{secret_key}' not found in any known secret store.")
    return None

async def publish_to_topic(topic_name: str, payload: str):
    """Publishes a message to a Pub/Sub topic (Async)."""
    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project_id:
        raise EnvironmentError("GOOGLE_CLOUD_PROJECT environment variable is required and must be set explicitly.")

    # publisher_v1.PublisherClient's publish method is already non-blocking (returns a future),
    # but we can wrap it to be more idiomatic async.
    publisher = pubsub_v1.PublisherClient()
    topic_path = publisher.topic_path(project_id, topic_name)
    
    data = payload.encode("utf-8")
    
    try:
        # publish is thread-safe and non-blocking
        future = publisher.publish(topic_path, data)
        # Wrap the future in an asyncio-compatible one
        loop = asyncio.get_event_loop()
        message_id = await loop.run_in_executor(None, future.result)
        logger.info(f"Published message {message_id} to {topic_name}")
        return message_id
    except Exception as e:
        logger.error(f"Error publishing to {topic_name}: {e}")
        raise

async def get_id_token(audience: str) -> str:
    """Fetches a Google OIDC ID token for the given audience (Async)."""
    # Requesting an ID token from the metadata server
    auth_request = Request()
    
    # metadata server is very fast, run in executor to keep loop free
    loop = asyncio.get_event_loop()
    try:
        token = await loop.run_in_executor(None, lambda: google.oauth2.id_token.fetch_id_token(auth_request, audience))
        return token
    except Exception as e:
        logger.error(f"Failed to fetch ID token for audience {audience}: {e}")
        return None

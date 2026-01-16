import os
import json
import logging
from google.cloud import secretmanager_v1, pubsub_v1
import asyncio

logger = logging.getLogger(__name__)

async def get_secret_value(secret_name, secret_key):
    """
    Get a secret from GCP Secret Manager or environment (Async).
    """
    # 1. Check if it's already in the Environment
    env_secret = os.environ.get(secret_key)
    if env_secret:
        return env_secret

    # 2. Fetch from GCP Secret Manager
    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project_id:
        raise ValueError("GOOGLE_CLOUD_PROJECT not set in environment")

    # Use the async client
    client = secretmanager_v1.SecretManagerServiceAsyncClient()
    name = f"projects/{project_id}/secrets/{secret_name}/versions/latest"
    
    try:
        response = await client.access_secret_version(request={"name": name})
        payload = response.payload.data.decode("UTF-8")
        secrets = json.loads(payload)
        return secrets[secret_key]
    except Exception as e:
        logger.error(f"Error accessing secret {secret_name}/{secret_key}: {e}")
        raise

async def publish_to_topic(topic_name: str, payload: str):
    """Publishes a message to a Pub/Sub topic (Async)."""
    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project_id:
        raise ValueError("GOOGLE_CLOUD_PROJECT not set in environment")

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

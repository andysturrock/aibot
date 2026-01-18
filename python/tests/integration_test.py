import os
import time
import hmac
import hashlib
import json
import httpx
import logging
from dotenv import load_dotenv

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("integration-test")

load_dotenv()

BASE_URL = f"https://{os.environ.get('CUSTOM_FQDN')}"
SLACK_SIGNING_SECRET = os.environ.get("SLACK_SIGNING_SECRET")

def generate_slack_headers(body: str, timestamp: str = None):
    if timestamp is None:
        timestamp = str(int(time.time()))
    
    sig_basestring = f"v0:{timestamp}:{body}"
    signature = "v0=" + hmac.new(
        SLACK_SIGNING_SECRET.encode(),
        sig_basestring.encode(),
        hashlib.sha256
    ).hexdigest()
    
    return {
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
        "Content-Type": "application/json"
    }

async def test_url_verification():
    logger.info("Testing /slack/events (url_verification)...")
    url = f"{BASE_URL}/slack/events"
    payload = {
        "type": "url_verification",
        "token": "test_token",
        "challenge": "challenge_accepted_123"
    }
    body = json.dumps(payload)
    headers = generate_slack_headers(body)
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, content=body, headers=headers, timeout=10.0)
            logger.info(f"Status: {response.status_code}")
            logger.info(f"Response: {response.text}")
            
            if response.status_code == 200:
                data = response.json()
                if data.get("challenge") == "challenge_accepted_123":
                    logger.info("SUCCESS: Challenge verified!")
                else:
                    logger.error(f"FAILURE: Unexpected challenge response: {data}")
            else:
                logger.error(f"FAILURE: Status code {response.status_code}")
        except Exception as e:
            logger.error(f"Error during test: {e}")

async def test_invalid_signature():
    logger.info("Testing /slack/events (invalid signature)...")
    url = f"{BASE_URL}/slack/events"
    payload = {"type": "event_callback", "event": {"type": "app_mention"}}
    body = json.dumps(payload)
    headers = {
        "X-Slack-Request-Timestamp": str(int(time.time())),
        "X-Slack-Signature": "v0=invalid_signature",
        "Content-Type": "application/json"
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post(url, content=body, headers=headers)
        logger.info(f"Status: {response.status_code} (Expected: 401)")
        if response.status_code == 401:
            logger.info("SUCCESS: Invalid signature correctly rejected!")
        else:
            logger.error(f"FAILURE: Expected 401 but got {response.status_code}")

async def test_health_check():
    logger.info("Testing /health...")
    url = f"{BASE_URL}/health"
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        logger.info(f"Status: {response.status_code}")
        if response.status_code == 200:
            logger.info("SUCCESS: Health check OK!")
        else:
            logger.error(f"FAILURE: Status {response.status_code}")

if __name__ == "__main__":
    import asyncio
    if not SLACK_SIGNING_SECRET:
        print("Error: SLACK_SIGNING_SECRET not found in .env")
        exit(1)
        
    asyncio.run(test_health_check())
    asyncio.run(test_url_verification())
    asyncio.run(test_invalid_signature())

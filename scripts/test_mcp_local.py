import asyncio
import logging
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("test_mcp_local")

async def get_slack_token():
    try:
        # Fetch the full JSON secret
        cmd = ["gcloud", "secrets", "versions", "access", "latest", "--secret=AIBot-shared-config", "--format=value(payload.data)"]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        
        if proc.returncode != 0:
            logger.error(f"Failed to fetch secret: {stderr.decode()}")
            return None
            
        import json
        secret_data = json.loads(stdout.decode().strip())
        return secret_data.get("slackUserToken")
    except Exception as e:
        logger.error(f"Error fetching token: {e}")
        return None

async def run_test():
    token = await get_slack_token()
    if not token or token == "REPLACE_ME":
        logger.error("Could not fetch valid Slack token from secrets.")
        return

    url = "http://127.0.0.1:8080/mcp/sse"
    headers = {"X-Slack-Token": token}
    
    logger.info(f"Connecting to {url}...")
    
    try:
        async with sse_client(url, headers=headers) as (read_stream, write_stream):
            logger.info("Connected to SSE stream.")
            async with ClientSession(read_stream, write_stream) as session:
                logger.info("Initializing session...")
                await session.initialize()
                
                logger.info("Listing tools...")
                tools = await session.list_tools()
                logger.info(f"Tools found: {[t.name for t in tools.tools]}")
                
                logger.info("Calling search_slack_messages...")
                # Note: This might timeout if GCP auth inside container is slow or blocked, 
                # but valid connection confirms the setup.
                result = await session.call_tool("search_slack_messages", arguments={"query": "hello"})
                
                logger.info(f"Result: {result.content[0].text}")
                
    except Exception as e:
        # Check for ExceptionGroup (common in anyio/asyncio)
        if hasattr(e, 'exceptions'):
             for ex in e.exceptions:
                 logger.error(f"Connection error details: {ex}")
        else:
             logger.error(f"Connection failed: {e}")
        
        print("\n\n⚠️  NOTE: If you see 'RemoteProtocolError: Server disconnected', it means the connection reached the server but was closed.")
        print("This confirms the network path is open. The disconnect might be due to client library header sizing or timeout.") 

if __name__ == "__main__":
    asyncio.run(run_test())

import os
import json
import logging
import asyncio
from typing import List, Dict, Any, Optional

from google.adk import Agent, Runner
from google.adk.tools.google_search_tool import google_search
from google.adk.tools import AgentTool
from google.genai import types
import vertexai
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client

gcp_location = os.environ.get("GCP_LOCATION")
if not gcp_location:
    raise EnvironmentError("GCP_LOCATION environment variable is required and must be set explicitly.")

# Initialize Vertex AI
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
vertexai.init(
    project=PROJECT_ID,
    location=gcp_location
)

# Import from shared library
from shared.gcp_api import get_secret_value, get_id_token
from shared.firestore_api import get_history, put_history

logger = logging.getLogger(__name__)

from google.adk.models.google_llm import Gemini
from google.genai import Client
from functools import cached_property

class VertexGemini(Gemini):
    """Subclass of Gemini that forces Vertex AI backend and configures project/location."""
    
    @cached_property
    def api_client(self) -> Client:
        from google.genai import Client
        return Client(
            vertexai=True,
            project=PROJECT_ID,
            location=gcp_location,
            http_options=types.HttpOptions(
                headers=self._tracking_headers(),
                retry_options=self.retry_options,
            )
        )

async def get_gemini_model(model_name: str) -> Gemini:
    """Factory to create a model with enterprise security settings."""
    return VertexGemini(
        model=model_name,
        generate_content_config=types.GenerateContentConfig(
            safety_settings=[
                types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_MEDIUM_AND_ABOVE"),
                types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_MEDIUM_AND_ABOVE"),
                types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_MEDIUM_AND_ABOVE"),
                types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_MEDIUM_AND_ABOVE"),
            ]
        )
    )

async def search_slack(query: str, user_token: Optional[str] = None) -> str:
    """
    Searches through Slack messages and summarizes the results.
    """
    try:
        if not user_token:
            user_token = await get_secret_value('slackUserToken')
            
        # Prefer env var for internal communication (bypasses IAP)
        mcp_server_url = os.environ.get("MCP_SEARCH_URL") or await get_secret_value('mcpSlackSearchUrl')
        
        iap_client_id = os.environ.get("IAP_CLIENT_ID")
        
        # 2. Authenticate: Determine if we need IAP token or Service Identity Token
        headers = {'X-Slack-Token': user_token}
        
        token_audience = None
        if "run.app" in mcp_server_url:
            # Internal Cloud Run URL -> Audience is the URL itself
            # We need to strip the protocol and path to get the audience if strictly required,
            # but usually the full service URL or base URL works.
            # However, for Service-to-Service on Cloud Run:
            # Audience should be the receiving service's URL.
            token_audience = mcp_server_url
            logger.info(f"debug: Detected internal Cloud Run URL. Using audience: {token_audience}")
        elif iap_client_id:
            # External IAP URL -> Audience is the IAP Client ID
            token_audience = iap_client_id
            logger.info(f"debug: Detected external IAP URL. Using audience: {token_audience}")
            
        if token_audience:
            try:
                id_token = await get_id_token(token_audience)
                if id_token:
                    logger.info(f"debug: ID Token generated successfully (len={len(id_token)})")
                    headers['Authorization'] = f'Bearer {id_token}'
                else:
                    logger.error("debug: get_id_token returned None")
            except Exception as e:
                logger.error(f"debug: Exception fetching ID token: {e}")
        else:
             logger.warning("debug: No suitable audience found for ID token generation")

        logger.info(f"debug: Headers keys prepared: {list(headers.keys())}")
        logger.info(f"debug: Connecting to MCP URL: {mcp_server_url}/mcp/sse")

        # 3. Use MCP Client to call the search tool
        # Ensure we append the correct path. logic: base_url + /sse (since server is mounted at root)
        # Use sse_client which takes (read, write) as return
        async with sse_client(f"{mcp_server_url}/sse", headers=headers) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool("search_slack_messages", arguments={"query": query})
                
                if not result.content or result.content[0].type != "text":
                    return "No results found in Slack."
                
                messages = result.content[0].text
                # Since messages is likely already a JSON string or a list of items,
                # we just return it. The Supervisor will summarize it anyway.
                return messages
    except Exception as e:
        logger.exception("Error in search_slack tool")
        return f"Error searching Slack: {str(e)}"

def create_google_search_agent(model: Gemini):
    return Agent(
        name="GoogleSearchAgent",
        description="An agent that can search Google for current public information.",
        instruction="You are a research expert. Use Google Search to find current facts. Always cite your sources with URLs.",
        tools=[google_search],
        model=model
    )

def create_slack_search_agent(model: Gemini, user_token: Optional[str] = None):
    # Capture user_token in a closure
    async def search_slack_tool(query: str) -> str:
        """Searches through Slack messages and summarizes the results."""
        return await search_slack(query, user_token=user_token)

    return Agent(
        name="SlackSearchAgent",
        description="An agent that can search internal Slack messages.",
        instruction="You are an internal researcher. Use Slack Search to find relevant conversations and summarize them.",
        tools=[search_slack_tool],
        model=model
    )

async def create_supervisor_agent(user_token: Optional[str] = None):
    bot_name = await get_secret_value('botName')
    model_name = await get_secret_value('supervisorModel')
    
    # Create models for all agents (can share or have individual configs)
    supervisor_model = await get_gemini_model(model_name)
    google_search_model = await get_gemini_model(model_name)
    slack_search_model = await get_gemini_model(model_name)
    
    return Agent(
        name="SupervisorAgent",
        description="Orchestrates specialized agents to answer user queries.",
        instruction=f"""
            Your name is {bot_name}.
            You are a supervisor that helps users.
            
            When you need to search for current public information, use the GoogleSearchAgent.
            When you need to find internal conversations or messages from Slack, use the SlackSearchAgent.
            
            Always provide the final answer in a structured JSON format:
            {{
              "answer": "your response here",
              "attributions": [{{ "title": "title", "uri": "uri" }}]
            }}
        """,
        model=supervisor_model,
        tools=[
            AgentTool(agent=create_google_search_agent(model=google_search_model)),
            AgentTool(agent=create_slack_search_agent(model=slack_search_model, user_token=user_token))
        ]
    )

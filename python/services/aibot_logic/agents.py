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
from mcp.client.streamable_http import StreamableHTTPTransport

gcp_location = os.environ.get("GCP_LOCATION")
if not gcp_location:
    raise EnvironmentError("GCP_LOCATION environment variable is required and must be set explicitly.")

# Initialize Vertex AI
vertexai.init(
    project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
    location=gcp_location
)

# Import from shared library
from shared.gcp_api import get_secret_value, get_id_token
from shared.firestore_api import get_history, put_history

logger = logging.getLogger(__name__)

async def get_gemini_model(model_name: str):
    """Helper to get model name (ADK in Python handles the model resolution)."""
    # In Python ADK, we can just pass the model name string to the agent
    # or a BaseLlm instance. For now, strings are easier.
    return model_name

async def search_slack(query: str, user_token: Optional[str] = None) -> str:
    """
    Searches through Slack messages and summarizes the results.
    """
    try:
        if not user_token:
            user_token = await get_secret_value('slackUserToken')
            
        mcp_server_url = await get_secret_value('mcpSlackSearchUrl')
        iap_client_id = os.environ.get("IAP_CLIENT_ID")
        
        # 2. Get ID Token for IAP if configured
        headers = {'X-Slack-Token': user_token}
        if iap_client_id:
            logger.debug(f"Fetching ID token for IAP audience: {iap_client_id}")
            id_token = await get_id_token(iap_client_id)
            if id_token:
                headers['Authorization'] = f'Bearer {id_token}'

        # 3. Use MCP Client to call the search tool
        async with StreamableHTTPTransport(f"{mcp_server_url}/mcp", headers=headers) as transport:
            async with ClientSession(transport) as session:
                await session.initialize()
                result = await session.call_tool("search_slack_messages", arguments={"query": query})
                
                if not result.content or result.content[0].type != "text":
                    return "No results found in Slack."
                
                messages = json.loads(result.content[0].text)
                return json.dumps(messages, indent=2)
    except Exception as e:
        logger.exception("Error in search_slack tool")
        return f"Error searching Slack: {str(e)}"

def create_google_search_agent():
    return Agent(
        name="GoogleSearchAgent",
        description="An agent that can search Google for current public information.",
        instruction="You are a research expert. Use Google Search to find current facts. Always cite your sources with URLs.",
        tools=[google_search]
    )

def create_slack_search_agent(user_token: Optional[str] = None):
    # Capture user_token in a closure
    async def search_slack_tool(query: str) -> str:
        """Searches through Slack messages and summarizes the results."""
        return await search_slack(query, user_token=user_token)

    return Agent(
        name="SlackSearchAgent",
        description="An agent that can search internal Slack messages.",
        instruction="You are an internal researcher. Use Slack Search to find relevant conversations and summarize them.",
        tools=[search_slack_tool]
    )

async def create_supervisor_agent(user_token: Optional[str] = None):
    bot_name = await get_secret_value('botName')
    model_name = await get_secret_value('supervisorModel')
    
    return Agent(
        name="SupervisorAgent",
        model=model_name,
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
        tools=[
            AgentTool(agent=create_google_search_agent()),
            AgentTool(agent=create_slack_search_agent(user_token=user_token))
        ],
        generate_content_config=types.GenerateContentConfig(
            safety_settings=[
                types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE")
            ]
        )
    )

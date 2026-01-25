import logging
import os
import time
from functools import cached_property

import vertexai
from google.adk import Agent
from google.adk.models.google_llm import Gemini
from google.adk.tools import AgentTool
from google.adk.tools.google_search_tool import google_search
from google.genai import Client, types
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from shared.firestore_api import get_google_token, put_google_token
from shared.gcp_api import get_secret_value
from shared.google_auth import refresh_google_id_token

gcp_location = os.environ.get("GCP_LOCATION")
if not gcp_location:
    raise OSError(
        "GCP_LOCATION environment variable is required and must be set explicitly."
    )

# Initialize Vertex AI
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
vertexai.init(project=PROJECT_ID, location=gcp_location)

logger = logging.getLogger(__name__)


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
            ),
        )


async def get_gemini_model(model_name: str) -> Gemini:
    """Factory to create a model with enterprise security settings."""
    return VertexGemini(
        model=model_name,
        generate_content_config=types.GenerateContentConfig(
            safety_settings=[
                types.SafetySetting(
                    category="HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold="BLOCK_MEDIUM_AND_ABOVE",
                ),
                types.SafetySetting(
                    category="HARM_CATEGORY_HARASSMENT",
                    threshold="BLOCK_MEDIUM_AND_ABOVE",
                ),
                types.SafetySetting(
                    category="HARM_CATEGORY_HATE_SPEECH",
                    threshold="BLOCK_MEDIUM_AND_ABOVE",
                ),
                types.SafetySetting(
                    category="HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold="BLOCK_MEDIUM_AND_ABOVE",
                ),
            ]
        ),
    )


async def get_valid_google_id_token(
    slack_user_id: str
) -> tuple[str | None, str | None]:
    """
    Retrieves a valid Google ID token for the given Slack user.
    Refreshes the token if it's expired.
    Returns (id_token, None) on success, or (None, error_message) on failure.
    """
    token_data = await get_google_token(slack_user_id)
    if not token_data:
        return (
            None,
            "I cannot search Slack because you are not signed in with Google. Please go to my Home tab and click 'Sign in with Google'.",
        )

    id_token = token_data.get("id_token")
    refresh_token = token_data.get("refresh_token")
    expires_at = token_data.get("expires_at", 0)

    # Refresh if expired (or close to it)
    if time.time() > expires_at - 300:  # 5 minute buffer
        if refresh_token:
            logger.info(f"Refreshing Google ID token for user {slack_user_id}")
            new_id_token = await refresh_google_id_token(refresh_token)
            if new_id_token:
                id_token = new_id_token
                # Update Firestore with new expiration
                token_data["id_token"] = id_token
                token_data["expires_at"] = time.time() + 3600
                await put_google_token(slack_user_id, token_data)
            else:
                return (
                    None,
                    "Your Google session has expired and I couldn't refresh it. Please sign in again on my Home tab.",
                )
        else:
            return (
                None,
                "Your Google session has expired. Please sign in again on my Home tab.",
            )

    return id_token, None


async def search_slack(query: str, slack_user_id: str) -> str:
    """
    Searches through Slack messages using the user's Google ID token for IAP.
    """
    try:
        if not slack_user_id or slack_user_id == "unknown":
            return "I cannot search Slack because I don't know who you are. Please interact with me from a Slack workspace."

        # 1. Get a valid Google ID Token
        id_token, error_msg = await get_valid_google_id_token(slack_user_id)
        if error_msg:
            return error_msg

        # 3. Connect to MCP
        mcp_server_url = await get_secret_value("mcpSlackSearchUrl")
        headers = {"Authorization": f"Bearer {id_token}"}

        logger.info(
            f"Connecting to MCP URL: {mcp_server_url}/sse for user {slack_user_id}"
        )

        async with sse_client(f"{mcp_server_url}/sse", headers=headers) as (
            read_stream,
            write_stream,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(
                    "search_slack_messages", arguments={"query": query}
                )

                if not result.content or result.content[0].type != "text":
                    return "No results found in Slack."

                return result.content[0].text
    except Exception as e:
        logger.exception("Error in search_slack tool")
        return f"Error searching Slack: {str(e)}"


def create_google_search_agent(model: Gemini):
    return Agent(
        name="GoogleSearchAgent",
        description="An agent that can search Google for current public information.",
        instruction="You are a research expert. Use Google Search to find current facts. Always cite your sources with URLs.",
        tools=[google_search],
        model=model,
    )


def create_slack_search_agent(model: Gemini, slack_user_id: str):
    # Capture slack_user_id in a closure
    async def search_slack_tool(query: str) -> str:
        """Searches through Slack messages and returns the raw message data."""
        return await search_slack(query, slack_user_id=slack_user_id)

    return Agent(
        name="SlackSearchAgent",
        description="An agent that can search internal Slack messages.",
        instruction="You are an internal researcher. Use the Slack Search tool to find relevant conversations. IMPORTANT: Return the raw result data exactly as received from the tool. Do NOT summarize the messages yourself; the Supervisor will handle the summarization and formatting.",
        tools=[search_slack_tool],
        model=model,
    )


async def create_supervisor_agent(slack_user_id: str):
    bot_name = await get_secret_value("botName")
    model_name = await get_secret_value("supervisorModel")

    # Create models for all agents (can share or have individual configs)
    supervisor_model = await get_gemini_model(model_name)
    google_search_model = await get_gemini_model(model_name)
    slack_search_model = await get_gemini_model(model_name)

    return Agent(
        name="SupervisorAgent",
        description="Orchestrates specialized agents to answer user queries.",
        instruction=f"""
            Your name is {bot_name}.
            You are a supervisor that helps users by orchestrating specialized agents.

            When you need to search for current public information, use the GoogleSearchAgent.
            When you need to find internal conversations or messages from Slack, use the SlackSearchAgent.

            **Response Guidelines**:
            1. **Summarize**: Combine findings from agents into a concise, non-repetitive narrative.
            2. **Deduplicate**: If the same information appears multiple times, only include it once.
            3. **Formatting**: Output your response **DIRECTLY in Slack mrkdwn**. Do NOT wrap your answer in JSON or code blocks.
                - Use `*bold*` for emphasis.
                - Use `-` or `*` for lists.
                - Use `<url|text>` for embedded links.
            4. **Citations**: Whenever you reference information from Slack or Google, you MUST include an inline link using the URL provided by the agent. For example: "...as discussed in <https://...|this conversation>."
        """,
        model=supervisor_model,
        tools=[
            AgentTool(agent=create_google_search_agent(model=google_search_model)),
            AgentTool(
                agent=create_slack_search_agent(
                    model=slack_search_model, slack_user_id=slack_user_id
                )
            ),
        ],
    )

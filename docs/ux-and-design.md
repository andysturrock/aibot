# UX and Design Philosophy

AIBot is designed to feel responsive, intelligent, and helpful, bridging the gap between static archives and active collaboration.

## 1. Responsive Feedback (UX)

Large language model operations and vector searches can take time. To ensure the user never feels ignored, we implemented:

### The "Keep Alive" System
When AIBot identifies a query that requires deep searching or complex synthesis (anything exceeding ~10 seconds), it automatically starts a background "keep alive" task.
- **Mechanism**: Sends whimsical, ephemeral messages to the user every 15 seconds.
- **Design Decision**: Ephemeral messages are used so as not to clutter the public Slack history.
- **Humor**: Statuses are randomized and humorous (e.g., *"Reticulating splines..."*, *"Polishing the dilithium crystals..."*) to reduce perceived wait time and improve user sentiment.

### Visual Cues
- **Eyes Reaction (👀)**: Immediately added upon receiving a valid request to acknowledge receipt.
- **Thinking Reaction (🤔)**: Stays active throughout the agent's processing loop and is automatically removed once the response is posted.

## 2. Conversation Continuity

AIBot treats Slack threads as unified "sessions."
- **Context Awareness**: All messages within a thread are treated as part of the same conversation. Users can ask follow-up questions (e.g., *"Tell me more about the first point"* or *"Who said that?"*) without repeating context.
- **Implementation**: The logic worker uses a `session_id` mapped to the Slack `thread_ts`. This state is persisted in Firestore, enabling cross-service and cross-invocation memory.

## 3. High-Performance Search

To stay within Slack's and Pub/Sub's processing windows, the search component is optimized for speed:
- **Parallel Fetching**: Instead of fetching conversation metadata sequentially, the MCP server uses `asyncio.gather` to request multiple Slack threads simultaneously.
- **Semantic Precision**: Uses Vertex AI embeddings to find meaning rather than just keyword matches, allowing the bot to answer questions like *"What was the consensus on the project launch?"* even if the exact word "consensus" wasn't used.

## 4. Engineering Decisions

### Why Pub/Sub?
Slack requires 200 OK responses within 3000ms. LLMs and Vector Search almost always exceed this limit. Pub/Sub acts as an asynchronous buffer, allowing the webhook to respond instantly while the logic worker handles the heavy lifting.

### Why MCP?
The Model Context Protocol (MCP) provides a standardized way for the LLM to interact with data. By wrapping Slack search in an MCP server, we can easily swap or add new data sources (e.g., GitHub, Jira) in the future without changing the core agent logic.

### Why Google OAuth?
Security is paramount. Instead of relying on a single administrative token, the bot uses Google OAuth to verify that the user asking the question has the appropriate permissions and identity to view the search results, ensuring internal data security.

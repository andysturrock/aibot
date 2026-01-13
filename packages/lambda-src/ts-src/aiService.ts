import {
  FunctionTool,
  GOOGLE_SEARCH,
  LlmAgent,
  ToolContext,
  InMemorySessionService,
  createEvent,
  Gemini,
  Event,
  AppendEventRequest,
  Runner,
  CreateSessionRequest,
  GeminiParams
} from '@google/adk';
import { Content, GenerateContentParameters, Type } from '@google/genai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/types';
import util from 'node:util';
import { getSecretValue } from './awsAPI';
import { handleSlackSearch } from './handleSlackSearch';
import { getHistory, putHistory } from './historyTable';
import * as slackAPI from './slackAPI';
import { postEphmeralErrorMessage, postMessage, PromptCommandPayload } from './slackAPI';

// Set default options for util.inspect to make it work well in CloudWatch
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.depth = null;
util.inspect.defaultOptions.colors = false;

export type Attribution = {
  title?: string
  uri?: string
};

export type ModelFunctionCallArgs = {
  /**
   * Prompt for the sub-agent
   */
  prompt?: string;
  /**
   * Used together with parentThreadTs as a key for conversation history
   */
  channelId: string;
  /**
   * Used together with channelId as a key for conversation history
   */
  parentThreadTs: string;
  /**
   * Used by the Slack Summary model to get messages using this user's token.
   * Ensures that users can only summarise channels they are allowed to see.
   */
  slackId?: string;
};

/**
 * A SessionService that persists conversation history to DynamoDB using the existing historyTable logic.
 * This acts as the "hook" requested to maintain custom data residency.
 */
class DynamoDBSessionService extends InMemorySessionService {
  private channelId: string;
  private threadTs: string;
  private agentName: string;

  constructor(channelId: string, threadTs: string, agentName: string) {
    super();
    this.channelId = channelId;
    this.threadTs = threadTs;
    this.agentName = agentName;
  }

  // Hook into appendEvent to save history back to DynamoDB after each event (user input, model response, tool call)
  override async appendEvent(request: AppendEventRequest): Promise<Event> {
    const result = await super.appendEvent(request);
    const session = request.session;

    // Convert the entire session history to Content[] format and save
    const history: Content[] = session.events
      .filter(e => e.content)
      .map(e => ({
        role: e.content?.role ?? 'user',
        parts: e.content?.parts ?? []
      } as Content));

    await putHistory(this.channelId, this.threadTs, history, this.agentName);
    return result;
  }
}

/**
 * [ADK_LIMITATION] The GeminiParams interface in @google/adk does not yet include 'tools' for Vertex AI Search.
 * We use this extended type to maintain type safety for other parameters while allowing the 'tools' field.
 */
type ADKGeminiParams = GeminiParams & {
  tools?: {
    retrieval: {
      vertexAiSearch: { datastore: string }
    }
  }[];
};

/**
 * Centralized factory to create Gemini models with consistent enterprise settings.
 * Ensures 'vertexai: true' is always set and GCP project/location are correctly scoped.
 */
async function getGeminiModel(modelName: string, dataStoreIds?: string[]) {
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const location = await getSecretValue('AIBot', 'gcpLocation');

  const params: ADKGeminiParams = {
    model: modelName,
    location: location,
    project: project,
    vertexai: true
  };

  if (dataStoreIds && dataStoreIds.length > 0) {
    params.tools = dataStoreIds.map(dataStoreId => ({
      retrieval: {
        vertexAiSearch: { datastore: `projects/${project}/locations/eu/collections/default_collection/dataStores/${dataStoreId}` }
      }
    }));
  }

  /**
   * [ADK_LIMITATION] The Gemini constructor explicitly expects GeminiParams. 
   * We use an unsafe cast here to allow the 'tools' property (for datastores) which is required for grounding,
   * while centralizing this workaround in a single place with clear justification.
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
  return new Gemini(params as unknown as any);
}

/**
 * Tool for searching Slack content.
 */
function createSearchSlackTool(): FunctionTool {
  return new FunctionTool({
    name: "searchSlack",
    description: "Searches through Slack messages and summarizes the results.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description: "The prompt to search for"
        }
      },
      required: ["prompt"]
    },
    execute: async (input: unknown, tool_context?: ToolContext): Promise<Content> => {
      const { prompt } = input as { prompt: string };
      if (!tool_context) {
        throw new Error("ToolContext is required for searchSlack");
      }
      const modelName = await getSecretValue('AIBot', 'slackSearchModel');
      const model = await getGeminiModel(modelName);

      const state = tool_context.invocationContext.session.state;
      const extraArgs: ModelFunctionCallArgs = {
        prompt,
        channelId: state.channelId as string,
        parentThreadTs: state.parentThreadTs as string,
        slackId: state.slackId as string
      };

      const generateContentRequest: GenerateContentParameters = {
        model: modelName,
        contents: []
      };

      const searchResponse = await handleSlackSearch(model, extraArgs, generateContentRequest);
      // GenerateContentResponse is a class, but we can access candidates safely here.
      const candidates = searchResponse.candidates;
      if (candidates?.[0]?.content?.parts?.[0]?.text) {
        return {
          role: 'model',
          parts: [{ text: candidates[0].content.parts[0].text }]
        } as Content;
      }
      return {
        role: 'model',
        parts: [{ text: "No results found in Slack." }]
      } as Content;
    }
  });
}

/**
 * Creates the Google Search Agent.
 */
async function createGoogleSearchAgent() {
  const modelName = await getSecretValue('AIBot', 'googleSearchGroundedModel');
  const model = await getGeminiModel(modelName);

  return new LlmAgent({
    name: "GoogleSearchAgent",
    description: "An agent that can search Google to answer questions about current events.",
    instruction: "You are a helpful assistant with access to Google search. You must cite your references when answering.",
    model: model,
    tools: [GOOGLE_SEARCH]
  });
}

/**
 * Creates the Custom Search Agent (Searching internal documents).
 */
async function createCustomSearchAgent() {
  const dataStoreIds = (await getSecretValue('AIBot', 'gcpDataStoreIds')).split(',');
  const modelName = await getSecretValue('AIBot', 'customSearchGroundedModel');

  const model = await getGeminiModel(modelName, dataStoreIds);

  return new LlmAgent({
    name: "CustomSearchAgent",
    description: "Searches through internal company documents and policies.",
    instruction: "You are a helpful assistant who specialises in searching through internal company documents.",
    model: model
  });
}

/**
 * Creates the Slack Search Agent.
 */
async function createSlackSearchAgent() {
  const modelName = await getSecretValue('AIBot', 'slackSearchModel');
  const model = await getGeminiModel(modelName);
  const searchSlackTool = createSearchSlackTool();

  return new LlmAgent({
    name: "SlackSearchAgent",
    description: "An agent that can search Slack messages.",
    model,
    tools: [searchSlackTool]
  });
}

/**
 * Creates the Supervisor Agent using ADK.
 */
export async function createSupervisorAgent() {
  const botName = await getSecretValue('AIBot', 'botName');
  const modelName = await getSecretValue('AIBot', 'supervisorModel');
  const model = await getGeminiModel(modelName);

  const slackSearchAgent = await createSlackSearchAgent();
  const googleSearchAgent = await createGoogleSearchAgent();
  const customSearchAgent = await createCustomSearchAgent();

  return new LlmAgent({
    name: "SupervisorAgent",
    model: model,
    description: "Orchestrates multiple specialized agents to answer user queries.",
    instruction: `
      Your name is ${botName}.
      You are a supervisor that can delegate tasks to specialized agents.
      1. Use SlackSearchAgent if the request is to search Slack.
      2. Use GoogleSearchAgent if the request is about general knowledge or current affairs.
      3. Use CustomSearchAgent if the request is about internal company matters or policies.
      
      Always provide the final answer in a structured JSON format:
{
  "answer": "your response here",
    "attributions": [{ "title": "title", "uri": "uri" }]
}
`,
    subAgents: [slackSearchAgent, googleSearchAgent, customSearchAgent]
  });
}

export type Response = {
  answer: string,
  attributions?: Attribution[]
};

export async function formatResponse(responseString: string) {
  // Strip markdown code blocks if present
  responseString = responseString.trim();
  responseString = responseString.replace(/^```json\s*/, '');
  responseString = responseString.replace(/```\s*$/, '');
  responseString = responseString.trim();

  let response: Response;
  try {
    response = JSON.parse(responseString) as Response;
    if (!response.answer) {
      const botName = await getSecretValue('AIBot', 'botName');
      response.answer = `${botName} did not respond.`;
    }
  }
  catch (error) {
    console.error(error);
    const answer = `(Sorry about the format, I couldn't parse the answer properly)\n${responseString}`;
    response = {
      answer
    };
  }

  response.answer = response.answer.replaceAll('**', '*');
  return response;
}

export function generateResponseBlocks(response: Response): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const lines = response.answer.split("\n").filter(line => line.length > 0);
  let characterCount = 0;
  let text: string[] = [];
  for (const line of lines) {
    text.push(line);
    characterCount += line.length;
    if (characterCount > 2000) {
      const sectionBlock: SectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: text.join("\n")
        }
      };
      blocks.push(sectionBlock);
      characterCount = 0;
      text = [];
    }
  }
  if (text.length > 0) {
    const sectionBlock: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: text.join("\n")
      }
    };
    blocks.push(sectionBlock);
  }
  if (response.attributions?.length && response.attributions.length > 0) {
    let elements: RichTextSection[] = [];
    elements = response.attributions.reduce((elements, attribution) => {
      if (attribution.uri) {
        const richTextLink: RichTextLink = {
          type: "link",
          url: attribution.uri,
          text: attribution.title
        };
        const richTextSection: RichTextSection = {
          type: "rich_text_section",
          elements: [richTextLink]
        };
        elements.push(richTextSection);
      }
      return elements;
    }, elements);

    const richTextList: RichTextList = {
      type: "rich_text_list",
      style: "ordered",
      elements
    };

    const richTextText: RichTextText = {
      type: "text",
      text: "References",
      style: { bold: true }
    };
    const richTextSection: RichTextSection = {
      type: "rich_text_section",
      elements: [richTextText]
    };
    const richTextBlock: RichTextBlock = {
      type: "rich_text",
      elements: [richTextSection, richTextList]
    };
    blocks.push(richTextBlock);
  }

  return blocks;
}

export async function removeReaction(channelId: string, eventTS: string): Promise<void> {
  try {
    await slackAPI.removeReaction(channelId, eventTS, "eyes");
  }
  catch {
    console.warn("Error removing reaction to original message - maybe the user deleted it.");
  }
}

export async function handlePromptCommand(event: PromptCommandPayload) {
  console.log(`handlePromptCommand event ${util.inspect(event, false, null)}`);
  await _handlePromptCommand(event);
}

export async function _handlePromptCommand(event: PromptCommandPayload): Promise<void> {
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??= "./clientLibraryConfig-aws-aibot.json";

  const channelId = event.channel;
  const parentThreadTs = event.thread_ts ?? event.ts;
  try {
    if (!parentThreadTs) {
      throw new Error("Need thread_ts or ts field in message");
    }
    if (!channelId) {
      throw new Error("Missing channel in event");
    }

    const prompt = event.text;

    // Load existing history
    const history = await getHistory(event.channel, parentThreadTs, "supervisor") ?? [];

    // Initialize custom session service for DynamoDB persistence hook
    const sessionService = new DynamoDBSessionService(event.channel, parentThreadTs, "supervisor");

    const userId = event.user_id;
    const sessionId = parentThreadTs;

    // Convert existing history to ADK Event format
    const adkEvents = history.map(h => createEvent({
      content: h,
      author: h.role === 'user' ? 'user' : 'SupervisorAgent'
    }));

    // [ADK_MIGRATION] adkEvents are now implicitly handled via session persistence.
    // We keep the creation logic for potential manual seeding but ignore it for now to satisfy lint.
    void adkEvents;

    const extraArgs: ModelFunctionCallArgs = {
      channelId,
      parentThreadTs,
      slackId: event.user_id
    };

    // Seed the session with existing history
    await sessionService.createSession({
      id: sessionId,
      appName: "AIBot",
      userId,
      state: extraArgs as unknown as Record<string, unknown>
    } as unknown as CreateSessionRequest);

    const supervisorAgent = await createSupervisorAgent();

    const runner = new Runner({
      agent: supervisorAgent,
      appName: "AIBot",
      sessionService: sessionService
    });

    let finalResponse = "";
    const newMessage: Content = {
      role: 'user',
      parts: [{ text: prompt }]
    };

    for await (const runnerEvent of runner.runAsync({
      userId,
      sessionId,
      newMessage,
      stateDelta: extraArgs as unknown as Record<string, unknown>
    })) {
      if (runnerEvent.content?.role === 'model' && runnerEvent.content.parts) {
        const textParts: string[] = runnerEvent.content.parts
          .filter(p => 'text' in p)
          .map(p => (p as { text: string }).text);
        if (textParts.length > 0) {
          finalResponse += textParts.join("");
        }
      }
    }

    if (!finalResponse) {
      finalResponse = "I'm sorry, I couldn't generate a response.";
    }

    const formattedResponse = await formatResponse(finalResponse);
    const blocks = generateResponseBlocks(formattedResponse);

    if (channelId && event.ts) {
      await removeReaction(channelId, event.ts);
      const text = formattedResponse.answer.slice(0, 3997) + "...";
      await postMessage(channelId, text, blocks, event.event_ts);
    }
  }
  catch {
    await postEphmeralErrorMessage(channelId, event.user_id, "Error calling AI API", parentThreadTs);
  }
}

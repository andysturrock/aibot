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
  GeminiParams,
  AgentTool,
  LoggingPlugin,
  BuiltInCodeExecutor
} from '@google/adk';
import { Content, GenerateContentParameters, Type, HarmCategory, HarmBlockThreshold, FinishReason } from '@google/genai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/types';
import util from 'node:util';
import { getSecretValue } from './awsAPI';
import { handleSlackSearch } from './handleSlackSearch';
import { getHistory, putHistory } from './historyTable';
import * as slackAPI from './slackAPI';
import { postEphmeralErrorMessage, postMessage, PromptCommandPayload } from './slackAPI';
export type { PromptCommandPayload } from './slackAPI';

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
 * The Inheritance Trick: Subclass BuiltInCodeExecutor so the Runner's 'instanceof' check passes,
 * but override its tool-injection logic to do NOTHING. This prevents the conflicting 'codeExecution'
 * tool from being added to model requests, resolving the Vertex AI 400 error.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class NoOpCodeExecutor extends BuiltInCodeExecutor {
  override async processLlmRequest(llmRequest: any): Promise<any> {
    // Doing nothing to avoid tool conflict with search tools,
    // but we MUST return the request so the runner can proceed.
    return llmRequest;
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
export async function getGeminiModel(modelName: string, dataStoreIds?: string[]) {
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
 * Creates an agent specialized in Google Search (Grounding).
 * This MUST be isolated as Vertex AI doesn't allow mixing grounding with other tools.
 */
export async function createGoogleSearchAgent() {
  const modelName = await getSecretValue('AIBot', 'supervisorModel');
  const model = await getGeminiModel(modelName);

  return new LlmAgent({
    name: "GoogleSearchAgent",
    description: "An agent that can search Google for current public information.",
    instruction: "You are a research expert. Use Google Search to find current facts. Always cite your sources with URLs.",
    model: model,
    tools: [GOOGLE_SEARCH],
    codeExecutor: new NoOpCodeExecutor()
  });
}

/**
 * Creates an agent specialized in searching Slack.
 */
export async function createSlackSearchAgent() {
  const modelName = await getSecretValue('AIBot', 'supervisorModel');
  const model = await getGeminiModel(modelName);

  return new LlmAgent({
    name: "SlackSearchAgent",
    description: "An agent that can search internal Slack messages.",
    instruction: "You are an internal researcher. Use Slack Search to find relevant conversations and summary them.",
    model: model,
    tools: [createSearchSlackTool()],
    codeExecutor: new NoOpCodeExecutor()
  });
}

/**
 * Creates the Supervisor Agent using ADK.
 */
export async function createSupervisorAgent() {
  const botName = await getSecretValue('AIBot', 'botName');
  const modelName = await getSecretValue('AIBot', 'supervisorModel');
  const model = await getGeminiModel(modelName);

  return new LlmAgent({
    name: "SupervisorAgent",
    model: model,
    description: "Orchestrates specialized agents to answer user queries.",
    instruction: `
      Your name is ${botName}.
      You are a supervisor that helps users.
      
      When you need to search for current public information, use the GoogleSearchAgent.
      When you need to find internal conversations or messages from Slack, use the SlackSearchAgent.
      
      Always provide the final answer in a structured JSON format:
      {
        "answer": "your response here",
        "attributions": [{ "title": "title", "uri": "uri" }]
      }
    `,
    tools: [
      new AgentTool({
        agent: await createGoogleSearchAgent()
      }),
      new AgentTool({
        agent: await createSlackSearchAgent()
      })
    ],
    codeExecutor: new NoOpCodeExecutor(),
    generateContentConfig: {
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
      ]
    }
  });
}

export type Response = {
  answer: string,
  attributions?: Attribution[]
};

export async function formatResponse(responseString: string) {
  // Strip markdown code blocks if present
  let processed = responseString.trim();
  processed = processed.replace(/^```json\s*/, '');
  processed = processed.replace(/```\s*$/, '');
  processed = processed.trim();

  let response: Response;
  try {
    response = JSON.parse(processed) as Response;
    if (!response.answer && processed !== responseString) { // If it was supposed to be JSON but answer is missing
      throw new Error("Missing answer in JSON");
    }
  }
  catch (error) {
    // If it's not JSON, treat the whole thing as the answer
    response = {
      answer: responseString.replaceAll('**', '*')
    };
    return response;
  }

  if (response.answer) {
    response.answer = response.answer.replaceAll('**', '*');
  }
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
    console.log(`Prompt: ${prompt}`);

    // Load existing history
    console.log("Loading history...");
    const history = await getHistory(event.channel, parentThreadTs, "supervisor") ?? [];
    console.log(`Loaded ${history.length} history events`);

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
    console.log(`Creating session with ID: ${sessionId}`);
    const session = await sessionService.createSession({
      sessionId: sessionId,
      appName: "AIBot",
      userId,
      state: extraArgs as unknown as Record<string, unknown>
    });

    if (history.length > 0) {
      console.log(`Adding ${history.length} history items to session...`);
      for (const content of history) {
        // Only append model and user messages, skip anything empty
        if (content.parts && content.parts.length > 0) {
          await sessionService.appendEvent({
            session,
            event: createEvent({ content })
          });
        }
      }
    }

    const checkSession = await sessionService.getSession({
      appName: "AIBot",
      userId,
      sessionId
    });
    console.log(`Session verification: ${checkSession ? 'Found' : 'NOT FOUND'}`);

    console.log("Creating agents...");
    const supervisorAgent = await createSupervisorAgent();

    const runner = new Runner({
      agent: supervisorAgent,
      appName: "AIBot",
      sessionService: sessionService,
      plugins: [new LoggingPlugin()]
    });

    console.log("Starting ADK runner...");
    let finalResponse = "";
    const newMessage: Content = {
      role: 'user',
      parts: [{ text: prompt }]
    };

    for await (const runnerEvent of runner.runAsync({
      userId,
      sessionId,
      newMessage: newMessage,
      stateDelta: extraArgs as unknown as Record<string, unknown>
    })) {
      console.log(`Runner event: ${util.inspect(runnerEvent, { depth: 1 })}`);
      if (runnerEvent.finishReason) {
        console.log(`Model finish reason: ${runnerEvent.finishReason}`);
      }

      if (runnerEvent.errorCode) {
        console.error(`Runner encountered error: ${runnerEvent.errorCode} - ${runnerEvent.errorMessage}`);
        // If we get an error, we should probably return it as the response.
        finalResponse = JSON.stringify({
          answer: `I encountered an error while processing your request: ${runnerEvent.errorMessage} (${runnerEvent.errorCode})`
        });
        break;
      }

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
      console.log("Sending response to Slack...");
      await removeReaction(channelId, event.ts);
      const text = formattedResponse.answer.slice(0, 3997) + "...";
      await postMessage(channelId, text, blocks, event.event_ts);
      console.log("Response sent.");
    }
  }
  catch (err) {
    console.error(`Error in _handlePromptCommand: ${util.inspect(err, { depth: null })}`);
    await postEphmeralErrorMessage(channelId, event.user_id, "Error calling AI API", parentThreadTs);
  }
}

import { Storage } from '@google-cloud/storage';
import {
  Tool,
  VertexAI
} from '@google-cloud/vertexai';
import { FunctionTool, GOOGLE_SEARCH, InMemoryRunner, LlmAgent, ToolContext } from '@google/adk';
import { Content, FileData, GenerateContentParameters, Part, Type } from '@google/genai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/types';
import axios, { AxiosRequestConfig } from 'axios';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import util from 'node:util';
import { getSecretValue } from './awsAPI';
import { handleSlackSearch } from './handleSlackSearch';
import { getHistory, GetHistoryFunction } from './historyTable';
import * as slackAPI from './slackAPI';
import { File, postEphmeralErrorMessage, postMessage, postTextMessage, PromptCommandPayload } from './slackAPI';

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
   * Used by the Files Handling model
   */
  fileDataParts?: Part[];
  /**
   * Used by the Slack Summary model to get messages using this user's token.
   * Ensures that users can only summarise channels they are allowed to see.
   */
  slackId?: string;
};

/**
 * Tool for searching Slack content.
 */
const searchSlackTool = new FunctionTool({
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
  execute: async (input: unknown, tool_context?: ToolContext): Promise<any> => {
    const { prompt } = input as { prompt: string };
    if (!tool_context) {
      throw new Error("ToolContext is required for searchSlack");
    }
    const extraArgs = tool_context.invocationContext.session.state as unknown as ModelFunctionCallArgs;
    const project = await getSecretValue('AIBot', 'gcpProjectId');
    const location = await getSecretValue('AIBot', 'gcpLocation');
    const vertexAI = new VertexAI({ project, location });
    const modelName = await getSecretValue('AIBot', 'slackSearchModel');
    const slackSearchModel = vertexAI.getGenerativeModel({ model: modelName });

    const generateContentRequest: GenerateContentParameters = {
      model: modelName,
      contents: []
    };

    return handleSlackSearch(slackSearchModel, { ...extraArgs, prompt }, generateContentRequest);
  }
});

/**
 * Creates the Slack Search Agent.
 */
async function createSlackSearchAgent() {
  const model = await getSecretValue('AIBot', 'slackSearchModel');
  return new LlmAgent({
    name: "SlackSearchAgent",
    description: "Searches through Slack messages and summarizes the results.",
    instruction: "You are a helpful assistant who can search for content in Slack messages and then summarise the results.",
    model: model,
    tools: [searchSlackTool]
  });
}

/**
 * Creates the Google Search Agent.
 */
async function createGoogleSearchAgent() {
  const model = await getSecretValue('AIBot', 'googleSearchGroundedModel');
  return new LlmAgent({
    name: "GoogleSearchAgent",
    description: "General knowledge assistant with access to Google Search.",
    instruction: "You are a helpful assistant with access to Google search. You must cite your references when answering.",
    model: model,
    tools: [GOOGLE_SEARCH]
  });
}

/**
 * Creates the Custom Search Agent (Vertex AI Search).
 */
async function createCustomSearchAgent() {
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const dataStoreIds = await getSecretValue('AIBot', 'gcpDataStoreIds');
  const modelName = await getSecretValue('AIBot', 'customSearchGroundedModel');

  const vertexAISearchTool = new FunctionTool({
    name: "vertexAISearch",
    description: "Searches through internal company documents and policies.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description: "The prompt for the search"
        }
      },
      required: ["prompt"]
    },
    execute: async (input: unknown): Promise<any> => {
      const { prompt } = input as { prompt: string };
      const location = await getSecretValue('AIBot', 'gcpLocation');
      const vertexAI = new VertexAI({ project, location });
      const tools: Tool[] = [];
      for (const dataStoreId of dataStoreIds.split(',')) {
        const datastore = `projects/${project}/locations/eu/collections/default_collection/dataStores/${dataStoreId}`;
        tools.push({
          retrieval: {
            vertexAiSearch: { datastore }
          }
        });
      }
      const searchModel = vertexAI.getGenerativeModel({
        model: modelName,
        tools
      });
      return searchModel.generateContent(prompt) as any;
    }
  });

  return new LlmAgent({
    name: "CustomSearchAgent",
    description: "Searches through internal company documents and policies.",
    instruction: "You are a helpful assistant who specialises in searching through internal company documents.",
    model: modelName,
    tools: [vertexAISearchTool]
  });
}

/**
 * Creates the Supervisor Agent using ADK.
 */
export async function createSupervisorAgent() {
  const botName = await getSecretValue('AIBot', 'botName');
  // const model = await getSecretValue('AIBot', 'supervisorAgentModel');
  const modelName = "gemini-2.0-flash-exp";

  const slackSearchAgent = await createSlackSearchAgent();
  const googleSearchAgent = await createGoogleSearchAgent();
  const customSearchAgent = await createCustomSearchAgent();

  return new LlmAgent({
    name: "SupervisorAgent",
    model: modelName,
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
  await _handlePromptCommand(event, getHistory);
}

export async function _handlePromptCommand(event: PromptCommandPayload, getHistoryFunction: GetHistoryFunction): Promise<void> {
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

    let fileDataArray: FileData[];
    try {
      fileDataArray = await transferFilesToGCS(event, parentThreadTs);
    }
    catch (_error) {
      await removeReaction(event.channel, event.event_ts);
      const text = (_error instanceof Error) ? _error.message : "Failed to transfer files to GCS";
      await postTextMessage(event.channel, text, parentThreadTs);
      return;
    }

    const fileDataParts = new Array<Part>();
    for (const fileData of fileDataArray) {
      const fileDataPart: Part = {
        fileData
      };
      fileDataParts.push(fileDataPart);
    }

    const prompt = event.text;
    await getHistoryFunction(event.channel, parentThreadTs, "supervisor");

    const extraArgs: ModelFunctionCallArgs = {
      channelId,
      parentThreadTs,
      fileDataParts,
      slackId: event.user_id
    };

    const supervisorAgent = await createSupervisorAgent();
    // Using InMemoryRunner for immediate execution
    const runner = new InMemoryRunner({
      agent: supervisorAgent,
      appName: "AIBot"
    });

    // Pass extraArgs via the session state as it's the only serializable way in TypeScript ADK
    const userId = event.user_id || "default_user";
    const sessionId = parentThreadTs;

    // Convert history parts to ADK compatible message contents if necessary
    // Note: ADK Messenger/Runner handles conversion, but we need to ensure local history is passed.
    // For now, we'll use state for extraArgs.

    let finalResponse = "";
    const newMessage: Content = {
      role: 'user',
      parts: [{ text: prompt }]
    };

    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage,
      stateDelta: extraArgs as unknown as Record<string, unknown>
    })) {
      if (event.content?.role === 'model' && event.content.parts) {
        const textParts = event.content.parts.filter(p => 'text' in p).map(p => (p as any).text);
        if (textParts.length > 0) {
          finalResponse += textParts.join("");
        }
      }
    }

    if (!finalResponse) {
      finalResponse = "I'm sorry, I couldn't generate a response.";
    }

    // Save history back (Runner usually manages this via SessionService, but we use historyTable)
    // We can extract updated history from runner's underlying session if needed, 
    // or just rely on the fact that we've finished the turn.
    // For now, let's just use the finalResponse as we would have before.

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

async function transferFilesToGCS(event: PromptCommandPayload, parentThreadTs: string) {
  const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');
  const documentBucketName = await getSecretValue('AIBot', 'documentBucketName');
  const handleFilesModel = await getSecretValue('AIBot', 'handleFilesModel');
  const botName = await getSecretValue('AIBot', 'botName');
  const fileDataArray: FileData[] = [];
  for (const file of event.files ?? []) {
    if (!isSupportedMimeType(file.mimetype)) {
      throw new Error(`${botName} using ${handleFilesModel} does not support file type ${file.mimetype}`);
    }
    else {
      try {
        const gsUri = await transferFileToGCS(slackBotToken, documentBucketName, event.user_id, file);
        const fileData: FileData = {
          mimeType: file.mimetype,
          fileUri: gsUri
        };
        fileDataArray.push(fileData);
        await postTextMessage(event.channel, `I have copied the file to Google storage at ${gsUri}.`, parentThreadTs);
      }
      catch {
        throw new Error(`Failed to upload file ${file.title} to Gemini`);
      }
    }
  }
  return fileDataArray;
}

async function transferFileToGCS(slackBotToken: string, documentBucketName: string, userId: string, file: File) {
  if (!file.url_private_download) {
    throw new Error("Missing url_private_download field");
  }
  const axiosRequestConfig: AxiosRequestConfig = {
    responseType: 'stream',
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5"
    },
  };
  const axiosResponse = await axios.get(file.url_private_download, axiosRequestConfig);
  const filename = path.basename(file.url_private_download);

  const storage = new Storage();
  const dateFolderName = new Date().toISOString().substring(0, 10);
  const gcsFilename = `${dateFolderName}/${userId}/${filename}`;
  const documentBucket = storage.bucket(documentBucketName);
  const bucketFile = documentBucket.file(gcsFilename);
  const bucketFileStream = bucketFile.createWriteStream();

  await pipeline(axiosResponse.data as Readable, bucketFileStream);
  return `gs://${documentBucketName}/${gcsFilename}`;
}

function isSupportedMimeType(mimetype: string) {
  const supported = supportedMimeTypes.find((supportedMimeType) => {
    return supportedMimeType.toUpperCase() == mimetype.toUpperCase();
  });
  return supported != undefined;
}

const supportedMimeTypes = [
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
  'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'application/x-javascript',
  'text/x-typescript', 'application/x-typescript', 'text/csv', 'text/markdown',
  'text/x-python', 'application/x-python-code', 'application/json', 'text/xml',
  'application/rtf', 'text/rtf', 'application/pdf',
];

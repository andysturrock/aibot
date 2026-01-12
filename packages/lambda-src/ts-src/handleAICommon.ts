import {
  GenerateContentRequest,
  GenerateContentResult,
  Part,
  Tool,
  Type,
  VertexAI
} from '@google-cloud/vertexai';
import { FunctionTool, GOOGLE_SEARCH, LlmAgent, ToolContext } from '@google/adk';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/types';
import util from 'util';
import { getSecretValue } from './awsAPI.js';
import { handleSlackSearch } from './handleSlackSearch.js';
import * as slackAPI from './slackAPI.js';

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
  execute: async (input: unknown, context: ToolContext): Promise<GenerateContentResult> => {
    const { prompt } = input as { prompt: string };
    const extraArgs = context.invocationContext.metadata as unknown as ModelFunctionCallArgs;
    const project = await getSecretValue('AIBot', 'gcpProjectId');
    const location = await getSecretValue('AIBot', 'gcpLocation');
    const vertexAI = new VertexAI({ project, location });
    const model = await getSecretValue('AIBot', 'slackSearchModel');
    const slackSearchModel = vertexAI.getGenerativeModel({ model });

    const generateContentRequest: GenerateContentRequest = {
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
  const model = await getSecretValue('AIBot', 'customSearchGroundedModel');

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
    execute: async (input: unknown): Promise<GenerateContentResult> => {
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
        model,
        tools
      });
      return searchModel.generateContent(prompt);
    }
  });

  return new LlmAgent({
    name: "CustomSearchAgent",
    description: "Searches through internal company documents and policies.",
    instruction: "You are a helpful assistant who specialises in searching through internal company documents.",
    model: model,
    tools: [vertexAISearchTool]
  });
}

/**
 * Creates the Supervisor Agent using ADK.
 */
export async function createSupervisorAgent() {
  const botName = await getSecretValue('AIBot', 'botName');
  // const model = await getSecretValue('AIBot', 'supervisorAgentModel');
  const model = "gemini-2.0-flash-exp";

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
        "attributions": [{"title": "title", "uri": "uri"}]
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
  // For some reason sometimes the answer gets wrapped in backticks, as if it's in markdown.
  // This is despite the prompt saying to use plain text not markdown.
  // Remove the ```json part
  let startingBackTicks = new RegExp(/^```json/);
  responseString = responseString.replace(startingBackTicks, '');
  // Remove the ending backticks.
  const endingBackTicks = new RegExp(/```\n*$/);
  responseString = responseString.replace(endingBackTicks, '');

  // Sometimes the model tries to write code to call a function itself.
  // This isn't helpful for the user but we can at least parse the result.
  startingBackTicks = new RegExp(/^```tool_code/);
  responseString = responseString.replace(startingBackTicks, '');

  // And properly escape a load of other characters
  responseString = responseString.replace(/\\n/g, "\\n")
    .replace(/\\'/g, "\\'")
    .replace(/\\"/g, '\\"')
    .replace(/\\&/g, "\\&")
    .replace(/\\r/g, "\\r")
    .replace(/\\t/g, "\\t")
    .replace(/\\b/g, "\\b")
    .replace(/\\f/g, "\\f");

  // Remove unprintable chars/unicode
  responseString = responseString.replace(/[^\x20-\x7E]/g, '');
  // Remove octal escape sequences
  responseString = responseString.replace(/\\[0-7]{3}/g, '');
  // Remove bullet point character
  responseString = responseString.replace(/\u2022/g, '');
  // Remove rightwards arrow character
  responseString = responseString.replace(/\u27B5/g, '');
  // Remove everything outside normal ASCII range
  responseString = responseString.replace(/[^ -~]/g, '');

  // First try to extract the model's answer into our expected JSON schema
  let response: Response;
  try {
    response = JSON.parse(responseString) as Response;
    if (!response.answer) {
      // There have been occasions where the model has returned "null" as the answer.
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

  // Do some basic translation of Google's markdown (which seems fairly standard)
  // to Slack markdown (which is not).
  response.answer = response.answer.replaceAll('**', '*');
  return response;
}

export function generateResponseBlocks(response: Response): KnownBlock[] {
  // Create some Slack blocks to display the results in a reasonable format
  const blocks: KnownBlock[] = [];

  // SectionBlock text elements have a limit of 3000 chars, so split into multiple blocks if needed.
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
  // Add a section with attributions if there were any.
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
  // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
  try {
    // There have been times when the AI API has been a bit slow and the user has
    // deleted their original message, so we'll just warn in the logs if we can't remove the
    // reaction.  Even if there is some other reason for the inability to remove the reaction
    // it'll be a better experience for the user to still get their summary.
    await slackAPI.removeReaction(channelId, eventTS, "eyes");
  }
  catch (error) {
    console.warn("Error removing reaction to original message - maybe the user deleted it.");
    console.warn(error);
  }
}



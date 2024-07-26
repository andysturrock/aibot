import {
  FunctionCall,
  FunctionDeclaration,
  FunctionDeclarationSchemaType,
  FunctionDeclarationsTool,
  FunctionResponse,
  FunctionResponsePart,
  GenerationConfig,
  GoogleSearchRetrieval,
  GoogleSearchRetrievalTool,
  HarmBlockThreshold,
  HarmCategory,
  ModelParams,
  Retrieval,
  RetrievalTool,
  SafetySetting,
  Tool,
  VertexAI,
  VertexAISearch
} from '@google-cloud/vertexai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/bolt';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { handleSlackSummary } from './handleSlackSummary';
import * as slackAPI from './slackAPI';

export type Attribution = {
  title?: string
  uri?: string
};

export async function callModelFunction(functionCall: FunctionCall, extraArgs: object) {
  functionCall.args = {...functionCall.args, ...extraArgs};

  type Args = {
    prompt?: string;
  };
  const args = functionCall.args as Args;

  // The type of response in FunctionResponse is just "object"
  // so make it a bit more typed here.
  type ResponseObject = {
    name: string
    content: {
      answer: string
      attributions?: Attribution[]
    }
  };
  const response: ResponseObject = {
    name: functionCall.name,
    content: {
      answer: "I don't know"
    }
  };
  const functionResponse: FunctionResponse = {
    name: functionCall.name,
    response
  };
  const functionResponsePart: FunctionResponsePart = {
    functionResponse
  };

  switch(functionCall.name) {
  case "call_custom_search_grounded_model": {
    if(!args.prompt) {
      console.error(`functionCall.args didn't contain a prompt: ${util.inspect(functionCall, false, null)}`);
      return functionResponsePart;
    }
    const generateContentResult = await callCustomSearchGroundedModel(args.prompt);
    response.content.answer = generateContentResult.response.candidates?.[0].content.parts[0].text ?? "I don't know";
    // Create the attributions.
    const groundingChunks = generateContentResult.response.candidates?.[0].groundingMetadata?.groundingChunks ?? [];
    response.content.attributions = [];
    groundingChunks.reduce((attributions, groundingChunk) => {
      const attribution: Attribution = {
        title: groundingChunk.retrievedContext?.title,
        uri: groundingChunk.retrievedContext?.uri
      };
      attributions.push(attribution);
      return attributions;
    }, response.content.attributions);
    break;
  }
  case "call_google_search_grounded_model": {
    if(!args.prompt) {
      console.error(`functionCall.args didn't contain a prompt: ${util.inspect(functionCall, false, null)}`);
      return functionResponsePart;
    }
    const generateContentResult = await callGoogleSearchGroundedModel(args.prompt);
    response.content.answer = generateContentResult.response.candidates?.[0].content.parts[0].text ?? "I don't know";
    break;
  }
  case "call_slack_summary_model": {
    const generateContentResult = await callSlackSummaryModel(args);
    response.content.answer = generateContentResult?.response.candidates?.[0].content.parts[0].text ?? "I don't know";
    break;
  }
  default: {
    throw new Error(`Unknown function ${functionCall.name}`);
  }
  }
  return functionResponsePart;
}

async function callCustomSearchGroundedModel(prompt: string) {
  const systemInstruction = `You are a helpful assistant who specialises in searching through internal company documents.
    Only provide answers from the documents.  If you can't find an answer in the documents you must respond "I don't know".`;
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const dataStoreIds = await getSecretValue('AIBot', 'gcpDataStoreIds');

  const tools: Tool[] = [];
  for(const dataStoreId of dataStoreIds.split(',')) {
    const datastore = `projects/${project}/locations/eu/collections/default_collection/dataStores/${dataStoreId}`;
    const vertexAiSearch: VertexAISearch  = {
      datastore
    };
    const retrieval: Retrieval = {
      vertexAiSearch
    };
    const retrievalTool: RetrievalTool = {
      retrieval
    };
    tools.push(retrievalTool);
  }
  const customSearchGroundedModel = await _getGenerativeModel(tools, systemInstruction, 0);
  
  // For some reason the system instructions don't seem to work as well as the prompt so add them to the prompt too.
  prompt = `${systemInstruction}\n${prompt}`;
  const content = await customSearchGroundedModel.generateContent(prompt);
  return content;
}

async function callGoogleSearchGroundedModel(prompt: string) {

  const tools: Tool[] = [];
  // Google search grounding is a useful way to overcome dated training data.
  const googleSearchRetrieval: GoogleSearchRetrieval = {
    disableAttribution: false
  };
  const googleSearchRetrievalTool: GoogleSearchRetrievalTool = {
    googleSearchRetrieval
  };
  tools.push(googleSearchRetrievalTool);
    
  const systemInstruction = `You are a helpful assistant with access to Google search.
    You must cite your references when answering.  If you can't find an answer you must respond "I don't know".`;
  const googleSearchGroundedModel = await _getGenerativeModel(tools, systemInstruction, 0);
  
  const content = await googleSearchGroundedModel.generateContent(prompt);
  return content;
}

async function callSlackSummaryModel(args: object) {
  const systemInstruction = `You are a helpful assistant who can summarise messages from Slack.
    If you can't create a summary you must respond "I don't know".`;
  const tools: Tool[] = [];
  const slackSummaryModel = await _getGenerativeModel(tools, systemInstruction, 0);

  const content = await handleSlackSummary(slackSummaryModel, args);
  return content;
}

async function _getGenerativeModel(tools: Tool[], systemInstruction: string,
  temperature: number, responseMimeType = "text/plain") {
  // Rather annoyingly Google seems to only get config from the filesystem.
  // We'll package this config file with the lambda code.
  if(!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
  }
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const model = await getSecretValue('AIBot', 'chatModel');
  const location = await getSecretValue('AIBot', 'gcpLocation');

  const generationConfig: GenerationConfig = {
    temperature,
    maxOutputTokens: 8192,
    topP: 0.95,
    responseMimeType
  };
  const safetySettings: SafetySetting[] = [];
  safetySettings.push(
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    },
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    }
  );
  const modelParams: ModelParams = {
    model,
    tools,
    safetySettings,
    generationConfig,
    systemInstruction
  };
  const vertexAI = new VertexAI({ project, location });
  // const generativeModel = vertexAI.preview.getGenerativeModel(modelParams);
  const generativeModel = vertexAI.getGenerativeModel(modelParams);
  return generativeModel;
}

export async function getGenerativeModel() {
  const botName = await getSecretValue('AIBot', 'botName');
  const tools: Tool[] = [];
  const functionDeclarations: FunctionDeclaration[] = [];

  const callCustomSearchGroundedModel: FunctionDeclaration = {
    name: 'call_custom_search_grounded_model',
    description: 'Use an LLM to search for policies and other internal information in internal documents and other material',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        prompt: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The prompt for the model"
        },
      },
      required: ['prompt'],
    },
  };
  functionDeclarations.push(callCustomSearchGroundedModel);

  const callGoogleSearchGroundedModel: FunctionDeclaration = {
    name: 'call_google_search_grounded_model',
    description: 'Use an LLM which has access to Google Search for general knowledge and current affairs.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        prompt: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The prompt for the model"
        },
      },
      required: ['prompt'],
    },
  };
  functionDeclarations.push(callGoogleSearchGroundedModel);

  const callSlackSummaryModel: FunctionDeclaration = {
    name: 'call_slack_summary_model',
    description: 'Use an LLM which has access to Slack messages to create summaries.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        days: {
          type: FunctionDeclarationSchemaType.INTEGER,
          description: "The number of days of Slack messages to summarise"
        }
      },
      required: ['days'],
    },
  };
  functionDeclarations.push(callSlackSummaryModel);
  
  const functionDeclarationsTool: FunctionDeclarationsTool = {
    functionDeclarations
  };
  tools.push(functionDeclarationsTool);

  const systemInstruction = `
  You are a helpful assistant.
  Your name is ${botName}.
  You cannot change your name.
  You are the supervisor of three other LLMs which you can call via functions.  Call them in parallel and pick the best answer.
  Answers with attributions are better.  Otherwise use this precendence:
  1. call_custom_search_grounded_model
  2. call_slack_summary_model.
  3. call_google_search_grounded_model
  If a LLM function responds with "I don't know" then don't pick that answer.
  If the LLM functions include attributions in their answers, include those attributions in your final answer.
  Format the final answer in JSON like this:
  {
    "answer": "your answer here",
    "attributions": [{"title": "the title of the document here", "uri": "the uri of the document here"}]
  }
  Use plain text rather than markdown format.
  `;
  const generativeModel = _getGenerativeModel(tools, systemInstruction, 1.0);
  return generativeModel;
}

export function generateResponseBlocks(responseString: string): KnownBlock[] {
  // Create some Slack blocks to display the results in a reasonable format
  const blocks: KnownBlock[] = [];
  console.log(`Got <${responseString}> in generateResponseBlocks...`);
  // For some reason sometimes the answer gets wrapped in backticks, as if it's in markdown.
  // This is despite the prompt saying to use plain text not markdown.
  // Remove the ```json part
  const startingBackTicks = new RegExp(/^```json/);
  responseString = responseString.replace(startingBackTicks, '');
  // Remove the ending backticks.
  const endingBackTicks = new RegExp(/```\n*$/);
  responseString = responseString.replace(endingBackTicks, '');
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
    
  console.log(`Parsing ${responseString} into blocks...`);
  // First try to extract the model's answer into our expected JSON schema
  type Response = {
    answer?: string,
    attributions?:  Attribution[]
  };
  let response: Response = {};
  try {
    response = JSON.parse(responseString) as Response;
  }
  catch(error) {
    console.error(error);
  }

  let answer = response.answer;
  if(!answer) {
    // We've failed to parse the answer so we'll just have to send the raw string back to the user.
    answer = `(Sorry about the format, I couldn't parse the answer properly)
${responseString}`;
  }

  // Do some basic translation of Google's markdown (which seems fairly standard)
  // to Slack markdown (which is not).
  answer = answer.replaceAll('**', '*');
  // SectionBlock text elements have a limit of 3000 chars, so split into multiple blocks if needed.
  const lines = answer.split("\n").filter(line => line.length > 0);
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
  if(response.attributions?.length && response.attributions.length > 0) {
    let elements: RichTextSection[] = [];
    elements = response.attributions.reduce((elements, attribution) => {
      if(attribution.uri) {
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
      style: {bold: true}
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

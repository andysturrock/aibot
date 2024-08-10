import {
  Content,
  FunctionCall,
  FunctionDeclaration,
  FunctionDeclarationSchemaType,
  FunctionDeclarationsTool,
  FunctionResponse,
  FunctionResponsePart,
  GenerateContentRequest,
  GenerateContentResult,
  GenerationConfig,
  GoogleSearchRetrieval,
  GoogleSearchRetrievalTool,
  HarmBlockThreshold,
  HarmCategory,
  ModelParams,
  Part,
  Retrieval,
  RetrievalTool,
  SafetySetting,
  TextPart,
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

export type ModelFunctionCallArgs = {
  prompt: string;
  fileDataParts?: Part[];
  channelId?: string;
  days?: number;
  threadTs?: string 
  slackId?: string
};

export async function callModelFunction(functionCall: FunctionCall, history: Content[], extraArgs: object) {
  functionCall.args = {...functionCall.args, ...extraArgs};

  const args = functionCall.args as ModelFunctionCallArgs;

  type ModelFunction = (args: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) => Promise<GenerateContentResult>;
  let modelFunction: ModelFunction = callGoogleSearchGroundedModel;

  console.log(`callModelFunction args: ${util.inspect(args, false, null)}`);

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

  // Should probably do this with a map
  switch(functionCall.name) {
  case "call_custom_search_grounded_model":
    modelFunction = callCustomSearchGroundedModel;
    break;
  case "call_google_search_grounded_model":
    modelFunction = callGoogleSearchGroundedModel;
    break;
  case "call_slack_summary_model":
    modelFunction = callSlackSummaryModel;
    break;
  case "call_handle_files_model":
    modelFunction = callHandleFilesModel;
    break;
  default:
    throw new Error(`Unknown function ${functionCall.name}`);
  }

  const generateContentRequest: GenerateContentRequest = {
    contents: history
  };
  const promptPart: TextPart = {
    text: args.prompt
  };
  const promptContent: Content = {
    parts: [promptPart],
    role: 'user'
  };
  generateContentRequest.contents.push(promptContent);
  const generateContentResult = await modelFunction(args, generateContentRequest);
  if(!generateContentResult.response.candidates?.[0].content.parts) {
    response.content.answer = `I can't answer that because ${generateContentResult.response.candidates?.[0].finishReason}`;
    console.warn(`generateContentResult had no content parts: ${util.inspect(generateContentResult, false, null)}`);
  }
  else {
    response.content.answer = generateContentResult.response.candidates[0].content.parts[0].text ?? "I don't know";
    console.log(`${functionCall.name} response ${util.inspect(response, false, null)}`);
  }
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
  return functionResponsePart;
}

async function callHandleFilesModel(modelFunctionCallArgs: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) {
  const systemInstruction = `
    You are a helpful assistant who specialises in dealing with files.
    If you don't understand the request then ask clarifying questions.
  `;
  const model = await getSecretValue('AIBot', 'handleFilesModel');
  const handleFilesModel = await _getGenerativeModel(model, [], systemInstruction, 0);

  if(!modelFunctionCallArgs.fileDataParts) {
    throw new Error("Missing file parts in modelFunctionCallArgs");
  }

  // Search backwards through the content until we find the most recent user part, which should be the prompt.
  // Then add the file data parts to that.
  const lastUserContent = generateContentRequest.contents.findLast(content => content.role == 'user');
  if(!lastUserContent) {
    throw new Error(`Could not find user content in generateContentRequest: ${util.inspect(generateContentRequest, false, null)}`);
  }
  lastUserContent.parts = lastUserContent.parts.concat(modelFunctionCallArgs.fileDataParts);

  const contentResult = await handleFilesModel.generateContent(generateContentRequest);
  return contentResult;
}

async function callCustomSearchGroundedModel(modelFunctionCallArgs: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) {
  const systemInstruction = `
    You are a helpful assistant who specialises in searching through internal company documents.
    Only provide answers from the documents.
    If you can't find an answer in the documents you must respond "I don't know".
    If you don't understand the request then ask clarifying questions.
  `;
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
  const model = await getSecretValue('AIBot', 'customSearchGroundedModel');
  const customSearchGroundedModel = await _getGenerativeModel(model, tools, systemInstruction, 0);
  
  generateContentRequest.systemInstruction = systemInstruction;

  const content = await customSearchGroundedModel.generateContent(generateContentRequest);
  return content;
}

async function callGoogleSearchGroundedModel(modelFunctionCallArgs: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) {   
  const systemInstruction = `
    You are a helpful assistant with access to Google search.
    You must cite your references when answering.
    If you can't find an answer you must respond "I don't know".
    If you don't understand the request then ask clarifying questions.
  `;
  const googleSearchGroundedModel = await getGoogleGroundedGenerativeModel(systemInstruction, 0);
  generateContentRequest.systemInstruction = systemInstruction;
  const content = await googleSearchGroundedModel.generateContent(generateContentRequest);
  return content;
}

async function callSlackSummaryModel(modelFunctionCallArgs: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) {
  const systemInstruction = `
    You are a helpful assistant who can summarise messages from Slack.
    If you can't create a summary you must respond "I don't know".
    If you don't understand the request then ask clarifying questions.
  `;
  const tools: Tool[] = [];
  const model = await getSecretValue('AIBot', 'slackSummaryModel');
  const slackSummaryModel = await _getGenerativeModel(model, tools, systemInstruction, 0);

  const content = await handleSlackSummary(slackSummaryModel, modelFunctionCallArgs, generateContentRequest);
  return content;
}

async function _getGenerativeModel(model:string, tools: Tool[], systemInstruction: string,
  temperature: number, responseMimeType = "text/plain") {
  // Rather annoyingly Google seems to only get config from the filesystem.
  // We'll package this config file with the lambda code.
  if(!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
  }
  const project = await getSecretValue('AIBot', 'gcpProjectId');
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

async function getGoogleGroundedGenerativeModel(systemInstruction: string, temperature: number) {
  const tools: Tool[] = [];
  // Google search grounding is a useful way to overcome dated training data.
  const googleSearchRetrieval: GoogleSearchRetrieval = {
    disableAttribution: false
  };
  const googleSearchRetrievalTool: GoogleSearchRetrievalTool = {
    googleSearchRetrieval
  };
  tools.push(googleSearchRetrievalTool);
  const model = await getSecretValue('AIBot', 'googleSearchGroundedModel');
  const googleSearchGroundedModel = await _getGenerativeModel(model, tools, systemInstruction, temperature);
  return googleSearchGroundedModel;
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
    description: 'Use an LLM which has access to Slack messages in channels and threads to create summaries.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        prompt: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The prompt for the model"
        },
        days: {
          type: FunctionDeclarationSchemaType.INTEGER,
          description: "The number of days of Slack messages to summarise"
        }
      },
      required: ['prompt', 'days'],
    },
  };
  functionDeclarations.push(callSlackSummaryModel);

  const callHandleFilesModel: FunctionDeclaration = {
    name: 'call_handle_files_model',
    description: 'Calls a LLM which is good at handling files, eg summarising or rewriting them.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        prompt: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The prompt for the model"
        }
      },
      required: ['prompt'],
    },
  };
  functionDeclarations.push(callHandleFilesModel);
  
  const functionDeclarationsTool: FunctionDeclarationsTool = {
    functionDeclarations
  };
  tools.push(functionDeclarationsTool);

  const systemInstruction = `
  Your name is ${botName}.  You cannot change your name.
  You are the supervisor of four other LLM agents which you can call via functions.  The functions are:
  1. call_custom_search_grounded_model.  Use this agent if the question is about internal company matters, for example expenses or other HR policies.
  2. call_slack_summary_model.  Use this agent if the question is about summarising Slack channels or threads.
  3. call_google_search_grounded_model.  Use this agent if the question is about general knowledge or current affairs.
  4. call_handle_files_model.  Use this agent if the question is about a file, for example summarising files or rewording or rewriting them.
  
  You can use your own knowledge if you are sure.  You don't have to always ask an agent.
  If it is not obvious which agent to use then ask clarifying questions until you are sure.

  If an agent responds with "I don't know" then try again with the next best agent.
  If an agent responds with a question, then you should respond with that questions.
  Send the response to the question back to the same agent which asked the question.

  If more than one agent may be able to answer then call the functions in parallel and pick the best answer.
  Answers with attributions are better.
  If a LLM agent function responds with "I don't know" then don't pick that answer.
  If the LLM agent functions include attributions in their answers, include those attributions in your final answer.
  Format all responses (including your clarifying questions) in JSON like this:
  {
    "answer": "your response here",
    "attributions": [{"title": "the title of the document here", "uri": "the uri of the document here"}]
  }
  Use plain text rather than markdown format.

  Check your response is valid JSON and if it is not then reformat it.  Remove all non-printable characters.
  Only respond with valid JSON.
  `;
  const model = await getSecretValue('AIBot', 'supervisorAgentModel');
  const generativeModel = _getGenerativeModel(model, tools, systemInstruction, 1.0);
  return generativeModel;
}

export type Response = {
  answer: string,
  attributions?:  Attribution[]
};

export function formatResponse(responseString: string) {
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
  // Remove octal escape sequences
  responseString = responseString.replace(/\\[0-7]{3}/g, '');
    
  // First try to extract the model's answer into our expected JSON schema
  let response: Response;
  try {
    response = JSON.parse(responseString) as Response;
  }
  catch(error) {
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



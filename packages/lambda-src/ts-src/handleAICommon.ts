import {
  Content,
  FunctionCall,
  FunctionCallingConfig,
  FunctionCallingMode,
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
  ToolConfig,
  VertexAI,
  VertexAISearch
} from '@google-cloud/vertexai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/types';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { handleSlackSearch } from './handleSlackSearch';
import { handleSlackSummary } from './handleSlackSummary';
import { GetHistoryFunction, PutHistoryFunction } from './historyTable';
import * as slackAPI from './slackAPI';
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
  /**
   * Used by the Slack Summary model.  Id of the channel to summarise.
   */
  summaryChannelId?: string;
  /**
   * Used by the Slack Summary model.  Timestamp (which is used as the id) of the thread to summarise.
   */
  summaryThreadTs?: string;
  /**
   * Used by the Slack Summary model.  Number of days to summarise.
   */
  summaryDays?: number;
};

export async function callModelFunction(functionCall: FunctionCall,
  extraArgs: object,
  getHistoryFunction: GetHistoryFunction,
  putHistoryFunction: PutHistoryFunction) {

  const args = {...extraArgs, ...functionCall.args} as ModelFunctionCallArgs;
  // All our function calls contain the prompt for the agent.
  // If it is missing then something has gone wrong and we can't continue.
  if(!args.prompt) {
    throw new Error("functionCall.args did not contain a prompt field.");
  }

  type ModelFunction = (args: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) => Promise<GenerateContentResult>;
  let modelFunction: ModelFunction = callGoogleSearchGroundedModel;

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
  // These are Vertex AI types that we will construct using the response above.
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
  case "call_slack_search_model":
    modelFunction = callSlackSearchModel;
    break;
  default:
    throw new Error(`Unknown function ${functionCall.name}`);
  }

  const history = await getHistoryFunction(args.channelId, args.parentThreadTs, functionCall.name) ?? [];
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
  // If there are no content parts it's because something has gone wrong, eg hit a safety stop.
  // The finishReason has the reason for the unexpected stop so tell the user that.
  if(!generateContentResult.response.candidates?.[0].content.parts) {
    response.content.answer = `I can't answer that because ${generateContentResult.response.candidates?.[0].finishReason}`;
    console.warn(`generateContentResult had no content parts: ${util.inspect(generateContentResult, false, null)}`);
  }
  else {
    response.content.answer = generateContentResult.response.candidates[0].content.parts[0].text ?? "I don't know";
  }
  // Add the agent's response to the history for this agent in this thread
  const responsePart: TextPart = {
    text: response.content.answer
  };
  const responseContent: Content = {
    parts: [responsePart],
    role: "model"
  };
  history.push(responseContent);
  await putHistoryFunction(args.channelId, args.parentThreadTs, history, functionCall.name);

  // Create the attributions
  response.content.attributions = [];
  // First from groundings.
  const groundingChunks = generateContentResult.response.candidates?.[0].groundingMetadata?.groundingChunks ?? [];
  groundingChunks.reduce((attributions, groundingChunk) => {
    const attribution: Attribution = {
      title: groundingChunk.retrievedContext?.title,
      uri: groundingChunk.retrievedContext?.uri
    };
    attributions.push(attribution);
    return attributions;
  }, response.content.attributions);
  // Or from Citations
  const citations = generateContentResult.response.candidates?.[0].citationMetadata?.citations ?? [];
  citations.reduce((attributions, citation) => {
    const attribution: Attribution = {
      title: citation.title,
      uri: citation.uri
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
  // The models don't seem to check back through their history for FileDataParts.
  // So search through our history for FileDataParts and add those to the current part.
  // The Set below is to keep track so we don't get duplicates.
  const fileUris = new Set<string>(modelFunctionCallArgs.fileDataParts.map((fileDataPart) => fileDataPart.fileData?.fileUri ?? ""));
  const historyFileDataParts = new Array<Part>();
  for(const content of generateContentRequest.contents) {
    for(const part of content.parts) {
      if(part.fileData) {
        if(!fileUris.has(part.fileData.fileUri)) {
          fileUris.add(part.fileData.fileUri);
          historyFileDataParts.push(part);
        }
      }
    }
  }
  lastUserContent.parts = lastUserContent.parts.concat(historyFileDataParts);
  
  // gemini-1.5-flash-001 doesn't seem to understand FileDataParts but it does seem to understand gs:// URIs.
  // So add the file URIs to the prompt.
  const fileURIList: string[] = [];
  modelFunctionCallArgs.fileDataParts.reduce((fileURIList, fileDataPart) => {
    if(fileDataPart.fileData?.fileUri) {
      fileURIList.push(fileDataPart.fileData.fileUri);
    }
    return fileURIList;
  }, fileURIList);
  if(fileURIList.length > 0) {
    const promptPart: TextPart = {
      text: `The files are available at ${fileURIList.join(",")}`
    };
    lastUserContent.parts.push(promptPart);
  }
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

  const generateContentResult = await handleSlackSummary(slackSummaryModel, modelFunctionCallArgs, generateContentRequest);
  return generateContentResult;
}

async function callSlackSearchModel(modelFunctionCallArgs: ModelFunctionCallArgs, generateContentRequest: GenerateContentRequest) {
  const systemInstruction = `
    You are a helpful assistant who can search for content in Slack messages and then summarise the results.
    If you can't find the answer or create a summary you must respond "I don't know".
    If you don't understand the request then ask clarifying questions.
  `;
  const tools: Tool[] = [];
  const model = await getSecretValue('AIBot', 'slackSearchModel');
  const slackSummaryModel = await _getGenerativeModel(model, tools, systemInstruction, 0);

  const generateContentResult = await handleSlackSearch(slackSummaryModel, modelFunctionCallArgs, generateContentRequest);
  return generateContentResult;
}

type GetGenerativeModelOptionalParams = {
  responseMimeType?: string;
  toolConfig?: ToolConfig
};
async function _getGenerativeModel(model:string, tools: Tool[], systemInstruction: string,
  temperature: number, getGenerativeModelOptionalParams: GetGenerativeModelOptionalParams = {responseMimeType: "text/plain"}) {
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const location = await getSecretValue('AIBot', 'gcpLocation');

  const generationConfig: GenerationConfig = {
    temperature,
    maxOutputTokens: 8192,
    topP: 0.95,
    responseMimeType: getGenerativeModelOptionalParams.responseMimeType
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
    systemInstruction,
    toolConfig: getGenerativeModelOptionalParams.toolConfig
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
  };
  const googleSearchRetrievalTool: GoogleSearchRetrievalTool = {
    googleSearchRetrieval
  };
  tools.push(googleSearchRetrievalTool);
  const model = await getSecretValue('AIBot', 'googleSearchGroundedModel');
  const googleSearchGroundedModel = await _getGenerativeModel(model, tools, systemInstruction, temperature);
  return googleSearchGroundedModel;
}

export type GetGenerativeModelDefaults = {
  slackSummaryDefaultDays: number;
  slackSummaryDefaultChannelId: string;
  slackSummaryDefaultThreadId: string;
};

export async function getGenerativeModel(getGenerativeModelDefaults: GetGenerativeModelDefaults) {
  const botName = await getSecretValue('AIBot', 'botName');
  const tools: Tool[] = [];
  const functionDeclarations: FunctionDeclaration[] = [];

  const callCustomSearchGroundedModel: FunctionDeclaration = {
    name: 'call_custom_search_grounded_model',
    description: 'Calls an LLM to search for policies and other internal information in internal documents and other material',
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
    description: 'Calls an LLM which has access to Google Search for general knowledge and current affairs.',
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
    description: 'Calls an LLM which has access to Slack messages in channels and threads to create summaries.',
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        prompt: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The prompt for the model"
        },
        summaryDays: {
          type: FunctionDeclarationSchemaType.INTEGER,
          description: "The number of days of Slack messages to summarise"
        },
        summaryChannelId: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The id of the Slack channel to summarise"
        },
        summaryThreadTs: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The id of the Slack thread to summarise"
        },
      },
      required: ['prompt', 'summaryDays', 'summaryChannelId'],
    },
  };
  functionDeclarations.push(callSlackSummaryModel);

  const callHandleFilesModel: FunctionDeclaration = {
    name: 'call_handle_files_model',
    description: 'Calls a LLM which is good at handling files, eg reading them, understanding them, summarising or rewriting them.',
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

  const callHandleSlackSearchModel: FunctionDeclaration = {
    name: 'call_slack_search_model',
    description: 'Calls a LLM which can search Slack for content.',
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
  functionDeclarations.push(callHandleSlackSearchModel);
 
  const functionDeclarationsTool: FunctionDeclarationsTool = {
    functionDeclarations
  };
  tools.push(functionDeclarationsTool);

  const systemInstruction = `
  Your name is ${botName}.  You cannot change your name.
  You are the supervisor of four other LLM agents which you can call via functions.  The functions are:
  1. call_custom_search_grounded_model.  Use this agent if the request is about internal company matters, for example expenses or other HR policies.
  2. call_slack_summary_model.  Use this agent if the request is about summarising Slack channels or threads.
  3. call_google_search_grounded_model.  Use this agent if the request is about general knowledge or current affairs.
  4. call_handle_files_model.  Use this agent if the request is about a file, for example summarising files or rewording or rewriting them.
  5. call_slack_search_model.  Use this agent if the request is to search Slack.

  If the request is about a file then you must pass the request straight to the file processing agent and use its answer as your response.
  If the request is not about a file then you can use your own knowledge if you are sure.
  If it is not obvious which agent to use then ask clarifying questions until you are sure.

  If the request mentions summarising channels or threads then it's probably about Slack, so use the Slack Summary agent.
  For the call_slack_summary_model, if the user doesn't specify the number of days then use ${getGenerativeModelDefaults.slackSummaryDefaultDays} as the summaryDays parameter.
  For the call_slack_summary_model, if the user doesn't specify the channel to summarise then use ${getGenerativeModelDefaults.slackSummaryDefaultChannelId} as the summaryChannelId parameter.
  For the call_slack_summary_model, if the user asks something like "summarise this thread" use ${getGenerativeModelDefaults.slackSummaryDefaultThreadId} as the summaryThreadTs parameter.  Otherwise use "undefined" as the summaryThreadTs parameter.

  If an agent responds that it can't answer then work out what is the next best agent and respond in JSON like this:
  {
    "answer": "The <agent name> could not answer that question.  Do you want me to ask <next best agent name>?",
  }
  Don't include the <> characters, they are just there to show you where to insert the agent names.

  The agent names for each function are:
  1. call_custom_search_grounded_model = Custom Search Agent
  2. call_slack_summary_model = Slack Summary Agent
  3. call_google_search_grounded_model = Google Search Agent
  4. call_handle_files_model = File Handling Agent
  5. call_slack_search_model = Slack Search Agent
  Use the agent names rather than the function names when responding to user queries.

  If an agent responds with a question, then you should respond with that question.
  Use JSON format like this to respond with the question:
  {
    "answer": "The <agent name> has asked '<question here>'",
  }
  Don't include the <> characters, they are just there to show you where to insert the agent names.
  When the user answers your question then send that answer back to the same agent which asked the question.

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

  If you see a string like <@U12345AB6C7> that is a user id in Slack.  Keep the string like that and do not change its format.
  If you see a string like <#C12345AB6C7> that is a channel id in Slack.  Keep the string like that and do not change its format.

  Check your response is valid JSON and if it is not then reformat it.  Remove all non-printable characters.
  Only respond with valid JSON.
  `;
  const model = await getSecretValue('AIBot', 'supervisorAgentModel');
  const functionCallingConfig: FunctionCallingConfig = {
    mode: FunctionCallingMode.AUTO
  };
  const toolConfig: ToolConfig = {
    functionCallingConfig
  };
  const generativeModel = _getGenerativeModel(model, tools, systemInstruction, 1.0, {toolConfig});
  return generativeModel;
}

export type Response = {
  answer: string,
  attributions?:  Attribution[]
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
    if(!response.answer) {
      // There have been occasions where the model has returned "null" as the answer.
      const botName = await getSecretValue('AIBot', 'botName');
      response.answer = `${botName} did not respond.`;
    }
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



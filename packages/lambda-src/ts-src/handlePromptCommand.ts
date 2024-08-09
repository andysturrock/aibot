import { Storage } from '@google-cloud/storage';
import {
  Content,
  FileData,
  FileDataPart,
  FunctionCall,
  Part,
  StartChatParams,
  TextPart
} from '@google-cloud/vertexai';
import axios, { AxiosRequestConfig } from 'axios';
import path from 'node:path';
import stream from 'node:stream/promises';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { callModelFunction, formatResponse, generateResponseBlocks, getGenerativeModel, ModelFunctionCallArgs, removeReaction } from './handleAICommon';
import { getHistory, putHistory } from './historyTable';
import { File, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage, PromptCommandPayload } from './slackAPI';

export async function handlePromptCommand(event: PromptCommandPayload) {
  console.log(`handlePromptCommand event ${util.inspect(event, false, null)}`);
  await _handlePromptCommand(event, getHistory, putHistory);
}

// The getHistoryFunction and putHistoryFunction args make this is easier to test.
type GetHistoryFunction = (slackId: string, threadTs: string) => Promise<Content[] | undefined>;
type PutHistoryFunction = (slackId: string, threadTs: string, history: Content[]) => Promise<void>;
export async function _handlePromptCommand(event: PromptCommandPayload,  getHistoryFunction: GetHistoryFunction, putHistoryFunction: PutHistoryFunction): Promise<void> {
  const responseUrl = event.response_url;
  const channelId = event.channel;

  try {
    // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
    const threadTs = event.thread_ts ?? event.event_ts;
    if(!threadTs) {
      throw new Error("Need thread_ts or event_ts field in event");
    }
    if(!channelId) {
      throw new Error("Missing channel in event");
    }

    const botName = await getSecretValue('AIBot', 'botName');
    const generativeModel = await getGenerativeModel();

    // If there are any files included in the message, move them to GCP storage.
    const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');
    const documentBucketName = await getSecretValue('AIBot', 'documentBucketName');
    const handleFilesModel = await getSecretValue('AIBot', 'handleFilesModel');
    const fileDataArray: FileData[]  = [];
    if(event.files) {
      for(const file of event.files) {
        try{
          if(!isSupportedMimeType(file.mimetype)) {
            await postEphmeralErrorMessage(channelId, event.user_id, `${botName} using ${handleFilesModel} does not support file type ${file.mimetype}`);  
          }
          else {
            const gsUri = await transferFileToGCS(slackBotToken, documentBucketName, event.user_id, file);
            const fileData: FileData = {
              mimeType: file.mimetype,
              fileUri: gsUri
            };
            fileDataArray.push(fileData);
          }
        }
        catch(error) {
          console.error(util.inspect(error, false, null));
          await postEphmeralErrorMessage(channelId, event.user_id, `Failed to upload file ${file.title} to Gemini`);
        }
      }
    }
    
    // Create the text part with the prompt
    let parts = new Array<Part>();
    const prompt = event.text;
    const textPart: TextPart = {
      text: prompt
    };
    parts.unshift(textPart);

    // Load the history if we're in a thread so the model remembers its context.
    let history = await getHistoryFunction(event.user_id, threadTs) ?? [];
    // Where we have Content with no parts add a dummy part.
    // MIssing content parts causes us and the Vertex AI API problems.
    // There really can be no parts to the content, despite the type system
    // saying they are mandatory.
    // This happens if we have hit a safety stop earlier in the conversation.
    // The content just contains:
    // { role: 'model' }
    history = fixMissingContentParts(history);
    console.log(`history: ${util.inspect(history, false, null)}`);
    
    // Add the file parts if the user has supplied them in this message.
    const fileDataParts = new Array<Part>();
    for(const fileData of fileDataArray) {
      const fileDataPart: FileDataPart = {
        fileData
      };
      fileDataParts.push(fileDataPart);
    }
    if(fileDataParts.length > 0) {
      // Currently function calls only work with text prompts in Gemini.
      // So rather than adding the file parts to the top level prompt we'll have to use a specific agent for working with files.
      // Give an instruction to the supervisor agent that it should chose the files agent.
      // We'll add the file parts below when the supervisor agent asks us to call the files agent.
      const fileUrisTextPart: TextPart = {
        text: `
          This request contains files.
          Make sure you call the file processing agent.
          The agent will be provided with the file directly when the function is called.
          Pass any requests directly to the file processing agent.
        `
      };
      parts.push(fileUrisTextPart);
    }

    // Add any file parts from the history.  We'll keep track of what we've added so we don't get duplicates.
    // Unfortunately JS Sets don't let you provide your own equality function so use a string set.
    const fileUris = new Set<string>(fileDataParts.map((fileDataPart) => fileDataPart.fileData?.fileUri ?? ""));
    console.log(`fileDataParts before history: ${util.inspect(fileDataParts, false, null)}`);
    for(const content of history) {
      console.log(`content: ${util.inspect(content, false, null)}`);
      for(const part of content.parts) {
        if(part.fileData) {
          if(!fileUris.has(part.fileData.fileUri)) {
            fileUris.add(part.fileData.fileUri);
            fileDataParts.push(part);
          }
        }
        // File parts show up in the function call arguments because we add them below.
        const modelFunctionCallArgs = part.functionCall?.args as ModelFunctionCallArgs | undefined;
        for(const functionCallFileDataPart of modelFunctionCallArgs?.fileDataParts ?? []) {
          if(functionCallFileDataPart.fileData && !fileUris.has(functionCallFileDataPart.fileData.fileUri)) {
            fileUris.add(functionCallFileDataPart.fileData.fileUri);
            fileDataParts.push(functionCallFileDataPart);
          }
        }
      }
    }
    console.log(`fileDataParts after history: ${util.inspect(fileDataParts, false, null)}`);
    if(fileDataParts.length > 0) {
      // See above for why we need to do this.
      // This time just give a hint, because all though the history of the chat contains files,
      // this specific request might be for someone unrelated to the files.
      const fileUrisTextPart: TextPart = {
        text: `\nThis request contains files.`
      };
      parts.push(fileUrisTextPart);
    }

    const startChatParams: StartChatParams = { };
    startChatParams.history = history;
    const chatSession = generativeModel.startChat(startChatParams);

    let response: string | undefined = undefined;
    while(response == undefined) {
      console.log(`Parts array input to chat: ${util.inspect(parts, false, null, true)}`);
      const generateContentResult = await chatSession.sendMessage(parts);

      const contentResponse = generateContentResult.response;
      console.log(`contentResponse: ${util.inspect(contentResponse, false, null, true)}`);
      
      // No response parts almost certainly means we've hit a safety stop.
      if(!generateContentResult.response.candidates?.[0].content.parts) {
        response = `{
          "answer": "I can't answer that because ${generateContentResult.response.candidates?.[0].finishReason}"
        }`;
        console.warn(`generateContentResult had no content parts: ${util.inspect(generateContentResult, false, null)}`);
      }
      else {
        response = contentResponse.candidates?.[0].content.parts[0].text;
      }

      // Response and function calls should be mutually exclusive, but check anyway.
      // We'll only call the functions if we don't have a response.
      if(!response) {
        const functionCalls: FunctionCall[] = [];
        // Gather all the function calls into one array.
        contentResponse.candidates?.[0].content.parts.reduce((functionCalls, part) => {
          if(part.functionCall) {
            functionCalls.push(part.functionCall);
          }
          return functionCalls;
        }, functionCalls);
        const extraArgs = {
          channelId,
          threadTs: event.thread_ts,
          fileDataParts
        };
        parts = new Array<Part>();
        for (const functionCall of functionCalls) {
          const functionResponsePart = await callModelFunction(functionCall, history, extraArgs);
          parts.push(functionResponsePart);
        }
      }
    }
    history = await chatSession.getHistory();
    // See above for why we add the blank content.
    history = fixMissingContentParts(history);
    await putHistoryFunction(event.user_id, threadTs, history);
    const formattedResponse = formatResponse(response);
    const blocks = generateResponseBlocks(formattedResponse);
        
    if(channelId && event.event_ts) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await removeReaction(channelId, event.event_ts);
      // Slack recommends truncating the text field to 4000 chars.
      // See https://api.slack.com/methods/chat.postMessage#truncating
      const text = formattedResponse.answer.slice(0, 3997) + "...";
      await postMessage(channelId, text, blocks, event.event_ts);
    }
    else {
      console.warn(`Could not post response ${util.inspect(blocks, false, null)}`);
    }
  }
  catch (error) {
    console.error(error);
    console.error(util.inspect(error, false, null));
    if(responseUrl) {
      await postErrorMessageToResponseUrl(responseUrl, "Failed to call AI API");
    }
    else if(channelId) {
      await postEphmeralErrorMessage(channelId, event.user_id, "Failed to call AI API");
    }
  }
}

async function transferFileToGCS(slackBotToken: string, documentBucketName: string, userId: string, file: File) {
  if(!file.url_private_download) {
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
  // Extract the filename from the URL rather than use the name.
  // Slack will have transformed any special chars etc.
  const filename = path.basename(file.url_private_download);
  
  // Stream the file directly from Slack to GCS (ie without writing to the filesystem here).
  const storage = new Storage();
  const dateFolderName = new Date().toISOString().substring(0, 10);
  const gcsFilename = `${dateFolderName}/${userId}/${filename}`;
  const documentBucket = storage.bucket(documentBucketName);
  const bucketFile = documentBucket.file(gcsFilename);
  const bucketFileStream = bucketFile.createWriteStream();
  
  await stream.pipeline(axiosResponse.data, bucketFileStream);
  console.log(`Transferred ${file.url_private_download} to ${documentBucketName}->${gcsFilename}`);
  return `gs://${documentBucketName}/${gcsFilename}`;
}

function isSupportedMimeType(mimetype: string) {
  const supported = supportedMimeTypes.find((supportedMimeType) => {
    return supportedMimeType.toUpperCase() == mimetype.toUpperCase();
  });
  return supported != undefined;
}
const supportedMimeTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/mpeg',
  'video/mov',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'application/x-javascript',
  'text/x-typescript',
  'application/x-typescript',
  'text/csv',
  'text/markdown',
  'text/x-python',
  'application/x-python-code',
  'application/json',
  'text/xml',
  'application/rtf',
  'text/rtf',
  'application/pdf',
];

function fixMissingContentParts(history: Content[]) {
  return history.map(content => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!content.parts) {
      content.parts = [{
        // This is probably true but doesn't really matter if not.
        text: "Stopped due to SAFETY"
      }];
    }
    return content;
  });
}
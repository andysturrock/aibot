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
import { callModelFunction, generateResponseBlocks, getGenerativeModel, removeReaction } from './handleAICommon';
import { getHistory, putHistory } from './historyTable';
import { File, PromptCommandPayload, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage } from './slackAPI';

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
    
    const startChatParams: StartChatParams = { };
    let history = await getHistoryFunction(event.user_id, threadTs);
    startChatParams.history = history;
    const chatSession = generativeModel.startChat(startChatParams);

    // If there are any files included in the message, download them here
    const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');
    const documentBucketName = await getSecretValue('AIBot', 'documentBucketName');
    const chatModel = await getSecretValue('AIBot', 'chatModel');
    const fileDataArray: FileData[]  = [];
    if(event.files) {
      for(const file of event.files) {
        try{
          if(!isSupportedMimeType(file.mimetype)) {
            await postEphmeralErrorMessage(channelId, event.user_id, `${botName} using ${chatModel} does not support file type ${file.mimetype}`);  
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
    let parts = new Array<Part>();
    for(const fileData of fileDataArray) {
      const fileDataPart: FileDataPart = {
        fileData
      };
      parts.push(fileDataPart);
    }

    const textPart: TextPart = {
      text: event.text
    };
    parts.push(textPart);

    let response: string | undefined = undefined;
    while(response == undefined) {
      console.log(`array input to chat: ${util.inspect(parts, false, null, true)}`);
      const generateContentResult = await chatSession.sendMessage(parts);

      const contentResponse = generateContentResult.response;
      console.log(`contentResponse: ${util.inspect(contentResponse, false, null, true)}`);
      response = contentResponse.candidates?.[0].content.parts[0].text;

      // reply and function calls should be mutually exclusive, but if we have a reply
      // then use that rather than call the functions.
      if(!response) {
        const functionCalls: FunctionCall[] = [];
        contentResponse.candidates?.[0].content.parts.reduce((functionCalls, part) => {
          if(part.functionCall) {
            functionCalls.push(part.functionCall);
          }
          return functionCalls;
        }, functionCalls);
        console.log(`functionCalls: ${util.inspect(functionCalls, false, null, true)}`);
        parts = new Array<Part>();
        for (const functionCall of functionCalls) {
          console.log(`***** functionCall: ${util.inspect(functionCall, false, null, true)}`);
          const extraArgs = {
            channelId,
            threadTs: event.thread_ts
          };
          const functionResponsePart = await callModelFunction(functionCall, extraArgs);
          console.log(`functionResponsePart: ${util.inspect(functionResponsePart, false, null, true)}`);
          parts.push(functionResponsePart);
        }
      }
    }
    history = await chatSession.getHistory();
    await putHistoryFunction(event.user_id, threadTs, history);
    const blocks = generateResponseBlocks(response);
        
    if(channelId && event.event_ts) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await removeReaction(channelId, event.event_ts);
      await postMessage(channelId, `${botName} response`, blocks, event.event_ts);
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
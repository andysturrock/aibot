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
import { getHistory, GetHistoryFunction, putHistory, PutHistoryFunction } from './historyTable';
import { File, postEphmeralErrorMessage, postMessage, postTextMessage, PromptCommandPayload } from './slackAPI';

export async function handlePromptCommand(event: PromptCommandPayload) {
  console.log(`handlePromptCommand event ${util.inspect(event, false, null)}`);
  await _handlePromptCommand(event, getHistory, putHistory);
}

// The getHistoryFunction and putHistoryFunction args make this is easier to test.
export async function _handlePromptCommand(event: PromptCommandPayload,  getHistoryFunction: GetHistoryFunction, putHistoryFunction: PutHistoryFunction): Promise<void> {
  // Rather annoyingly Google seems to only get config from the filesystem.
  // We'll package this config file with the lambda code.
  if(!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
  }
  
  const channelId = event.channel;

  // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
  // Every message has a ts field.  Because this message is passed to us as an event it will also
  // have an event_ts field.  The ts and event_ts fields will be equal.
  // If the message is in a thread it will also have a thread_ts field which indicates the
  // parent message from the thread.
  // Either way if we use the main message ts or the parent thread ts as the ts to reply to, then
  // Slack will create the thread or reply in the thread correctly.
  // We also want to use the parent thread ts consistently as the key for the history.
  const parentThreadTs = event.thread_ts ?? event.ts;
  try {
    
    if(!parentThreadTs) {
      throw new Error("Need thread_ts or ts field in message");
    }
    if(!channelId) {
      throw new Error("Missing channel in event");
    }

    const botName = await getSecretValue('AIBot', 'botName');

    // If there are any files included in the message, move them to GCP storage.
    const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');
    const documentBucketName = await getSecretValue('AIBot', 'documentBucketName');
    const handleFilesModel = await getSecretValue('AIBot', 'handleFilesModel');
    const fileDataArray: FileData[]  = [];
    if(event.files) {
      for(const file of event.files) {
        try{
          if(!isSupportedMimeType(file.mimetype)) {
            // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
            await removeReaction(channelId, event.ts);
            await postTextMessage(channelId, `${botName} using ${handleFilesModel} does not support file type ${file.mimetype}`, parentThreadTs);
            return;
          }
          else {
            const gsUri = await transferFileToGCS(slackBotToken, documentBucketName, event.user_id, file);
            const fileData: FileData = {
              mimeType: file.mimetype,
              fileUri: gsUri
            };
            fileDataArray.push(fileData);
            await postTextMessage(channelId, `I have stored the file at ${gsUri}.`, parentThreadTs);
          }
        }
        catch(error) {
          console.error(util.inspect(error, false, null));
          // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
          await removeReaction(channelId, event.ts);
          await postTextMessage(channelId, `Failed to upload file ${file.title} to Gemini`, parentThreadTs);
          return;
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
    let history = await getHistoryFunction(event.channel, parentThreadTs, "supervisor") ?? [];
    // Where we have Content with no parts add a dummy part.
    // Missing content parts causes us and the Vertex AI API problems.
    // There really can be no parts to the content, despite the type system
    // saying they are mandatory.
    // This happens if we have hit a safety stop earlier in the conversation.
    // The content just contains:
    // { role: 'model' }
    // so this function adds some content parts.
    history = fixMissingContentParts(history);
    
    // Add the file parts if the user has supplied them in this message.
    let fileDataParts = new Array<Part>();
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
          This request contains one or more files.
          You must pass this request to the file processing agent.
          The agent will be provided with the files directly when the function is called.
          Pass any requests directly to the file processing agent.
          Do not answer requests about the files yourself.  You must pass all requests to the file processing agent.
        `
      };
      parts.push(fileUrisTextPart);
    }

    // Add any file parts from the history.  We'll keep track of what we've added so we don't get duplicates.
    // Unfortunately JS Sets don't let you provide your own equality function so use a string set.
    const fileUris = new Set<string>(fileDataParts.map((fileDataPart) => fileDataPart.fileData?.fileUri ?? ""));
    const historyFileDataParts = new Array<Part>();
    for(const content of history) {
      for(const part of content.parts) {
        if(part.fileData) {
          if(!fileUris.has(part.fileData.fileUri)) {
            fileUris.add(part.fileData.fileUri);
            historyFileDataParts.push(part);
          }
        }
        // File parts show up in the function call arguments because we add them below.
        const modelFunctionCallArgs = part.functionCall?.args as ModelFunctionCallArgs | undefined;
        for(const functionCallFileDataPart of modelFunctionCallArgs?.fileDataParts ?? []) {
          if(functionCallFileDataPart.fileData && !fileUris.has(functionCallFileDataPart.fileData.fileUri)) {
            fileUris.add(functionCallFileDataPart.fileData.fileUri);
            historyFileDataParts.push(functionCallFileDataPart);
          }
        }
      }
    }
    if(historyFileDataParts.length > 0) {
      // See above for why we need to do this.
      const fileUrisTextPart: TextPart = {
        text: `
          The conversation earlier was about one or more files.
          Those files were provided directly to the file processing agent.
          If this request is about the files then pass this request to the file processing agent.
          If you pass a futher request to the file processing agent it will be provided with the files again.
          Do not answer requests about the files yourself.  You must pass all requests to the file processing agent.
        `
      };
      parts.push(fileUrisTextPart);
    }
    fileDataParts = fileDataParts.concat(historyFileDataParts);

    const startChatParams: StartChatParams = { };
    startChatParams.history = history;
    const generativeModel = await getGenerativeModel();
    const chatSession = generativeModel.startChat(startChatParams);

    let response: string | undefined = undefined;
    while(response == undefined) {
      console.log(`Parts array input to supervisor chat: ${util.inspect(parts, false, null, true)}`);
      const generateContentResult = await chatSession.sendMessage(parts);

      const contentResponse = generateContentResult.response;
      console.log(`supervisor contentResponse: ${util.inspect(contentResponse, false, null, true)}`);
      
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
        // TODO - this isn't quite right because we're sending a threadTs even though the
        // question might be about the main channel.  Eg if in a thread the user asks
        // "summarise the last 7 days of this channel" they are only going to get the summary
        // of the thread.
        // We could have two agents, one for summarising channels and one for summarising threads.
        // Or maybe do some prompt engineering around passing threadTs in the model args only if the
        // request is specifically about threads.
        const extraArgs: ModelFunctionCallArgs = {
          channelId,
          parentThreadTs,
          fileDataParts,
          slackId: event.user_id,
          threadTs: event.thread_ts
        };
        parts = new Array<Part>();
        for (const functionCall of functionCalls) {
          const functionResponsePart = await callModelFunction(functionCall, extraArgs, getHistoryFunction, putHistoryFunction);
          parts.push(functionResponsePart);
        }
      }
    }
    history = await chatSession.getHistory();
    // See above for why we add the blank content.
    history = fixMissingContentParts(history);
    await putHistoryFunction(event.channel, parentThreadTs, history, "supervisor");
    const formattedResponse = formatResponse(response);
    const blocks = generateResponseBlocks(formattedResponse);

    if(channelId && event.ts) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await removeReaction(channelId, event.ts);
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
    await postEphmeralErrorMessage(channelId, event.user_id, "Error calling AI API", parentThreadTs);
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
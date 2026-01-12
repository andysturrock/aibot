import { Storage } from '@google-cloud/storage';
import {
  Content,
  FileData,
  FileDataPart,
  Part,
  TextPart
} from '@google-cloud/vertexai';
import { Runner } from '@google/adk';
import axios, { AxiosRequestConfig } from 'axios';
import path from 'node:path';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { createSupervisorAgent, formatResponse, generateResponseBlocks, ModelFunctionCallArgs, removeReaction } from './handleAICommon';
import { getHistory, GetHistoryFunction, putHistory, PutHistoryFunction } from './historyTable';
import { File, postEphmeralErrorMessage, postMessage, postTextMessage, PromptCommandPayload } from './slackAPI';
// Set default options for util.inspect to make it work well in CloudWatch
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.depth = null;
util.inspect.defaultOptions.colors = false;

export async function handlePromptCommand(event: PromptCommandPayload) {
  console.log(`handlePromptCommand event ${util.inspect(event, false, null)}`);
  await _handlePromptCommand(event, getHistory, putHistory);
}

// The getHistoryFunction and putHistoryFunction args make this easier to test.
export async function _handlePromptCommand(event: PromptCommandPayload, getHistoryFunction: GetHistoryFunction, putHistoryFunction: PutHistoryFunction): Promise<void> {
  // Rather annoyingly Google seems to only get config from the filesystem.
  // We'll package this config file with the lambda code.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
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

    if (!parentThreadTs) {
      throw new Error("Need thread_ts or ts field in message");
    }
    if (!channelId) {
      throw new Error("Missing channel in event");
    }

    // If there are any files included in the message, move them to GCP storage.
    let fileDataArray: FileData[];
    try {
      fileDataArray = await transferFilesToGCS(event, parentThreadTs);
    }
    catch (error) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await removeReaction(event.channel, event.event_ts);
      const text = (error instanceof Error) ? error.message : "Failed to transfer files to GCS";
      await postTextMessage(event.channel, text, parentThreadTs);
      return;
    }
    // Create file parts to supply to the File Agent later.
    const fileDataParts = new Array<Part>();
    for (const fileData of fileDataArray) {
      const fileDataPart: FileDataPart = {
        fileData
      };
      fileDataParts.push(fileDataPart);
    }
    let parts = new Array<Part>();
    // Currently function calls only work with text prompts in Gemini.
    // So rather than adding the file parts to the top level prompt we'll have to
    // use a specific agent for working with files.
    // If we have file parts then add some additional prompting.
    // Otherwise the supervisor seems reluctant to actually call the File Processing agent
    // We'll pass the file parts to the Files agent below when the supervisor agent asks us to call it.
    if (fileDataParts.length > 0) {
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

    // Create a text part with the prompt
    const prompt = event.text;
    const textPart: TextPart = {
      text: prompt
    };
    // Add it as the first part of the content.
    parts.unshift(textPart);

    // Load the history if we're in a thread so the model remembers its context.
    let history = await getHistoryFunction(event.channel, parentThreadTs, "supervisor") ?? [];
    // There really can be no Parts to the Content, despite the type system
    // saying they are mandatory.
    // This happens if we have hit a safety stop earlier in the conversation.
    // The Content just contains:
    // { role: 'model' }
    // Missing Content Parts causes us and the Vertex AI API problems,
    // so this function adds some dummy Parts to the Content.
    history = fixMissingContentParts(history);

    const supervisorAgent = await createSupervisorAgent();
    // Extra args for tools
    const extraArgs: ModelFunctionCallArgs = {
      channelId,
      parentThreadTs,
      fileDataParts,
      slackId: event.user_id
    };

    const runner = new Runner({
      agent: supervisorAgent,
      history: history
    });

    const runnerResult = await runner.run(prompt, extraArgs);
    const lastResponse = runnerResult.responses[runnerResult.responses.length - 1];
    let response = lastResponse?.content ?? "I don't know";

    // Update history
    history = runner.history;
    history = fixMissingContentParts(history);
    await putHistoryFunction(event.channel, parentThreadTs, history, "supervisor");
    const formattedResponse = await formatResponse(response);
    const blocks = generateResponseBlocks(formattedResponse);

    if (channelId && event.ts) {
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

/**
 * Transfer files to GCP.
 * @param event 
 * @param parentThreadTs 
 * @returns Array of FileData (empty if there were no files).
 * @throws Error if the file type is not supported or a problem saving to GCS.
 */
async function transferFilesToGCS(event: PromptCommandPayload, parentThreadTs: string) {
  // If there are any files included in the message, move them to GCP storage.
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
      catch (error) {
        console.error(util.inspect(error, false, null));
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
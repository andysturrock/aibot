import {
  Content,
  FunctionCall,
  Part,
  StartChatParams,
  TextPart
} from '@google-cloud/vertexai';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { callModelFunction, generateResponseBlocks, getGenerativeModel, removeReaction } from './handleAICommon';
import { getHistory, putHistory } from './historyTable';
import { PromptCommandPayload, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage } from './slackAPI';

export async function handlePromptCommand(event: PromptCommandPayload) {
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

    const textPart: TextPart = {
      text: event.text
    };
    let array = new Array<Part>();
    array.push(textPart);
    let response: string | undefined = undefined;
    while(response == undefined) {
      console.log(`array input to chat: ${util.inspect(array, false, null, true)}`);
      const generateContentResult = await chatSession.sendMessage(array);

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
        array = new Array<Part>();
        for (const functionCall of functionCalls) {
          console.log(`***** functionCall: ${util.inspect(functionCall, false, null, true)}`);
          const extraArgs = {
            channelId,
            threadTs: event.thread_ts
          };
          const functionResponsePart = await callModelFunction(functionCall, extraArgs);
          console.log(`functionResponsePart: ${util.inspect(functionResponsePart, false, null, true)}`);
          array.push(functionResponsePart);
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

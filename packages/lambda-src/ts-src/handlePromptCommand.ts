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
  console.log(`event: ${util.inspect(event, false, null)}`);
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {
    const botName = await getSecretValue('AIBot', 'botName');
    const generativeModel = await getGenerativeModel();

    // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
    const threadTs = event.thread_ts ?? event.event_ts;
    if(!threadTs) {
      throw new Error("Need thread_ts or event_ts field in event");
    }
    
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
        // if(contentResponse.candidates?.[0].content.parts) {
        contentResponse.candidates?.[0].content.parts.reduce((functionCalls, part) => {
          // console.log(`part: ${util.inspect(part, false, null, true)}`);
          if(part.functionCall) {
            functionCalls.push(part.functionCall);
          }
          return functionCalls;
        }, functionCalls);
        console.log(`functionCalls: ${util.inspect(functionCalls, false, null, true)}`);
        array = new Array<Part>();
        for (const functionCall of functionCalls) {
          console.log(`***** functionCall: ${util.inspect(functionCall, false, null, true)}`);
          const functionResponsePart = await callModelFunction(functionCall);
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

// export async function handlePromptCommandOld(event: PromptCommandPayload,
//   getHistoryFunction = getHistory,
//   putHistoryFunction = putHistory): Promise<void> {
//   console.log(`event: ${util.inspect(event, false, null)}`);
//   const responseUrl = event.response_url;
//   const channelId = event.channel;
//   try {
//     const botName = await getSecretValue('AIBot', 'botName');
//     const betaUserSlackIds = await getSecretValue('AIBot', 'betaUserSlackIds');
//     console.log(`betaUserSlackIds: ${betaUserSlackIds}`);
//     const useCustomSearchGrounding = event.user_id.match(new RegExp(betaUserSlackIds)) !== null;
//     console.log(`useCustomSearchGrounding: ${useCustomSearchGrounding}`);
//     const generativeModel = await getGenerativeModel();

//     // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
//     const threadTs = event.thread_ts ?? event.event_ts;
//     if(!threadTs) {
//       throw new Error("Need thread_ts or event_ts field in event");
//     }
    
//     const startChatParams: StartChatParams = { };
//     let history = await getHistoryFunction(event.user_id, threadTs);
//     startChatParams.history = history;
//     const chatSession = generativeModel.startChat(startChatParams);
//     const generateContentResult = await chatSession.sendMessage(event.text);
//     history = await chatSession.getHistory();
//     await putHistoryFunction(event.user_id, threadTs, history);
//     const contentResponse: GenerateContentResponse = generateContentResult.response;
//     const sorry = "Sorry I couldn't answer that.";
//     console.log(`generateContentResult: ${util.inspect(generateContentResult, false, null)}`);
//     const response = contentResponse.candidates? contentResponse.candidates[0].content.parts[0].text : sorry;
//     // Seem to get duplicate attributions so use a Set to check we don't have it already.
//     // Annoyingly JS Sets use object equals and you can't override it to do content equality,
//     // otherwise would just put the attributions in a set directly to make unique.
//     const groundingAttributionWebs: GroundingAttributionWeb[] = [];
//     const urls = new Set<string>();
//     for(const groundingAttribution of contentResponse.candidates?.[0].groundingMetadata?.groundingAttributions ?? []) {
//       if(groundingAttribution.web?.uri && !urls.has(groundingAttribution.web.uri)) {
//         urls.add(groundingAttribution.web.uri);
//         groundingAttributionWebs.push(groundingAttribution.web);
//       } 
//     }
    
//     const blocks = generateResponseBlocks(response, sorry, groundingAttributionWebs);
        
//     if(channelId && event.event_ts) {
//       // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
//       await removeReaction(channelId, event.event_ts);
//       await postMessage(channelId, `${botName} response`, blocks, event.event_ts);
//     }
//     else {
//       console.warn(`Could not post response ${util.inspect(response, false, null)}`);
//     }
//   }
//   catch (error) {
//     console.error(error);
//     console.error(util.inspect(error, false, null));
//     if(responseUrl) {
//       await postErrorMessageToResponseUrl(responseUrl, "Failed to call AI API");
//     }
//     else if(channelId) {
//       await postEphmeralErrorMessage(channelId, event.user_id, "Failed to call AI API");
//     }
//   }
// }
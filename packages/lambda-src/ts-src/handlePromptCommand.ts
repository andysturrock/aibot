import { GenerateContentResponse, GroundingAttributionWeb, StartChatParams } from '@google-cloud/vertexai';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { generateResponseBlocks, getGenerativeModel, removeReaction } from './handleAICommon';
import { getHistory, putHistory } from './historyTable';
import { PromptCommandPayload, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage } from './slackAPI';

export async function handlePromptCommand(event: PromptCommandPayload): Promise<void> {
  console.log(`event: ${util.inspect(event, false, null)}`);
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {
    const botName = await getSecretValue('AIBot', 'botName');
    const betaUserSlackIds = await getSecretValue('AIBot', 'betaUserSlackIds');
    console.log(`betaUserSlackIds: ${betaUserSlackIds}`);
    const useCustomSearchGrounding = event.user_id.match(new RegExp(betaUserSlackIds)) !== null;
    console.log(`useCustomSearchGrounding: ${useCustomSearchGrounding}`);
    const generativeModel = await getGenerativeModel({useGoogleSearchGrounding: true, useCustomSearchGrounding: useCustomSearchGrounding});

    // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
    const threadTs = event.thread_ts ?? event.event_ts;
    if(!threadTs) {
      throw new Error("Need thread_ts or event_ts field in event");
    }
    
    const startChatParams: StartChatParams = { };
    let history = await getHistory(event.user_id, threadTs);
    startChatParams.history = history;
    const chatSession = generativeModel.startChat(startChatParams);
    const generateContentResult = await chatSession.sendMessage(event.text);
    history = await chatSession.getHistory();
    await putHistory(event.user_id, threadTs, history);
    const contentResponse: GenerateContentResponse = generateContentResult.response;
    const sorry = "Sorry I couldn't answer that.";
    console.log(`generateContentResult: ${util.inspect(generateContentResult, false, null)}`);
    const response = contentResponse.candidates? contentResponse.candidates[0].content.parts[0].text : sorry;
    // Seem to get duplicate attributions so use a Set to check we don't have it already.
    // Annoyingly JS Sets use object equals and you can't override it to do content equality,
    // otherwise would just put the attributions in a set directly to make unique.
    const groundingAttributionWebs: GroundingAttributionWeb[] = [];
    const urls = new Set<string>();
    for(const groundingAttribution of contentResponse.candidates?.[0].groundingMetadata?.groundingAttributions ?? []) {
      if(groundingAttribution.web?.uri && !urls.has(groundingAttribution.web.uri)) {
        urls.add(groundingAttribution.web.uri);
        groundingAttributionWebs.push(groundingAttribution.web);
      } 
    }
    
    const blocks = generateResponseBlocks(response, sorry, groundingAttributionWebs);
        
    if(channelId && event.event_ts) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await removeReaction(channelId, event.event_ts);
      await postMessage(channelId, `${botName} response`, blocks, event.event_ts);
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
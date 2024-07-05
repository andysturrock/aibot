import util from 'util';
import { getSecretValue } from './awsAPI';
import { generateResponseBlocks, getGenerativeModel, removeReaction } from './handleAICommon';
import { PromptCommandPayload, getChannelMessages, getThreadMessages, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage } from './slackAPI';

export async function handleSummariseCommand(event: PromptCommandPayload): Promise<void> {
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {
    const botName = await getSecretValue('AIBot', 'botName');
    const generativeModel = await getGenerativeModel();

    // If we have been invoked by the "lumos" command we'll make the summary more sassy.
    const sassy = event.text.toLowerCase().includes("lumos") ? "Make the summary really sassy." : "";

    // If the event has a thread_ts field we'll summarise the thread.
    // Else we'll summarise the channel.
    let request = "";
    if(event.thread_ts && event.channel) {
      const messages = await getThreadMessages(event.channel, event.thread_ts);
      const texts: string[] = [];
      for(const message of messages) {
        texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
      }
      request = `This is a collection of messages in a thread in a Slack channel in the format "date - user: message".
        When you see a string like <@XYZ123> that is a user id.
        Refer to the user by that user id in your answer.  Keep the < and the > characters around the user id.
        Try to include dates in your answer.
        Please summarise the messages below.
        ${sassy}
        ${texts.join("\n")}`;
    }
    else if(event.channel) {
      const thirtyDaysAgo = new Date(new Date().getTime() - (30 * 24 * 60 * 60 * 1000));
      // Slack's timestamps are in seconds rather than ms.
      const messages = await getChannelMessages(event.channel, `${thirtyDaysAgo.getTime() / 1000}`, true);
      // Messages are returned most recent at the start of the array, so swap that round.
      messages.reverse();
      const texts: string[] = [];
      for(const message of messages) {
        texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
      }
      request = `This is a collection of messages in a Slack channel in the format "date - user: message".
        When you see a string like <@XYZ123> that is a user id.
        Refer to the user by that user id in your answer.  Keep the < and the > characters around the user id.
        Try to include dates in your answer.
        Please summarise the messages below.
        ${sassy}
        ${texts.join("\n")}`;
    }
    else {
      throw new Error("Need channel or thread_ts field in event");
    }

    const sorry = "Sorry - I couldn't summarise that.";
    const generateContentResult = await generativeModel.generateContent(request);
    const contentResponse = generateContentResult.response;
    const response = contentResponse.candidates? contentResponse.candidates[0].content.parts[0].text : sorry;

    const blocks = generateResponseBlocks(response, sorry);
        
    if(channelId && event.event_ts) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await removeReaction(channelId, event.event_ts);
      await postMessage(channelId, `${botName} summary`, blocks, event.event_ts);
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
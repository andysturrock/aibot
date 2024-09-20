import { GenerateContentRequest, GenerativeModel, GenerativeModelPreview, TextPart } from '@google-cloud/vertexai';
import util from 'util';
import { ModelFunctionCallArgs } from './handleAICommon';
import { getChannelMessages, getThreadMessages } from './slackAPI';

export async function handleSlackSummary(slackSummaryModel: GenerativeModel | GenerativeModelPreview,
  modelFunctionCallArgs: ModelFunctionCallArgs,
  generateContentRequest: GenerateContentRequest) {
  if(!modelFunctionCallArgs.slackId) {
    throw new Error("Missing slackId parameter");
  }
  if(!modelFunctionCallArgs.channelId) {
    throw new Error("Missing channelId parameter");
  }
  if(!modelFunctionCallArgs.days) {
    throw new Error("Missing days parameter");
  }
  if(modelFunctionCallArgs.threadTs == "undefined") {
    modelFunctionCallArgs.threadTs = undefined;
  }

  // If the event has a thread_ts field we'll summarise the thread.
  // Else we'll summarise the channel.
  let prompt = `
    This is a collection of messages in a Slack channel in the format "date - user: message".
    When you see a string like <@XYZ123> that is a user id.
    Refer to the user by that user id in your answer.  Keep the < and the > characters around the user id.
    Try to include some dates in your answer, but you don't need to refer to every message in your answer as this is a summary not a full list.
    Split your answer into a separate lines for each date you refer to.
    Make each line of your answer less than 2500 characters long.
    Please summarise the messages below.
  `;
  const texts: string[] = [];
  const now = new Date();
  const xDaysAgo = new Date(now.getTime() - (modelFunctionCallArgs.days * 24 * 60 * 60 * 1000));
  const oldest = `${xDaysAgo.getTime() / 1000}`; // Slack timestamps are in seconds rather than millis
  const latest = `${now.getTime() / 1000}`;
  if(modelFunctionCallArgs.threadTs) {
    const messages = await getThreadMessages(modelFunctionCallArgs.slackId,
      modelFunctionCallArgs.channelId,
      modelFunctionCallArgs.parentThreadTs,
      oldest,
      latest
    );
    for(const message of messages) {
      texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
    }
  }
  else {
    // Slack's timestamps are in seconds rather than ms.
    const messages = await getChannelMessages(modelFunctionCallArgs.slackId,
      modelFunctionCallArgs.channelId,
      oldest,
      latest,
      true);
    // Messages are returned most recent at the start of the array, so swap that round.
    messages.reverse();
    for(const message of messages) {
      texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
    }
  }
  prompt = prompt + texts.join("\n");

  // Search backwards through the content until we find the most recent user part, which should be the original prompt.
  // Then add a text part to that with all the detail above.
  const lastUserContent = generateContentRequest.contents.findLast(content => content.role == 'user');
  if(!lastUserContent) {
    throw new Error(`Could not find user content in generateContentRequest: ${util.inspect(generateContentRequest, false, null)}`);
  }
  const promptPart: TextPart = {
    text: prompt
  };
  lastUserContent.parts.push(promptPart);
  return await slackSummaryModel.generateContent(generateContentRequest);
}

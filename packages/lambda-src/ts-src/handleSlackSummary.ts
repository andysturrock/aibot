import { GenerativeModel, GenerativeModelPreview } from '@google-cloud/vertexai';
import util from 'util';
import { getChannelMessages, getThreadMessages } from './slackAPI';

export async function handleSlackSummary(slackSummaryModel: GenerativeModel | GenerativeModelPreview, argsObs: object) {
  type Args = {
    channelId?: string,
    days?: number,
    threadTs?: string 
  };
  const args = argsObs as Args;
  if(!args.channelId) {
    throw new Error("");
  }
  if(!args.days) {
    throw new Error("");
  }
  if(args.threadTs == "undefined") {
    args.threadTs = undefined;
  }
  try {
    // If the event has a thread_ts field we'll summarise the thread.
    // Else we'll summarise the channel.
    let request = "";
    if(args.threadTs && args.channelId) {
      const messages = await getThreadMessages(args.channelId, args.threadTs);
      const texts: string[] = [];
      for(const message of messages) {
        texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
      }
      request = `This is a collection of messages in a thread in a Slack channel in the format "date - user: message".
        When you see a string like <@XYZ123> that is a user id.
        Refer to the user by that user id in your answer.  Keep the < and the > characters around the user id.
        Try to include dates in your answer.
        Please summarise the messages below.
        ${texts.join("\n")}`;
    }
    else if(args.channelId) {
      const xDaysAgo = new Date(new Date().getTime() - (args.days * 24 * 60 * 60 * 1000));
      // Slack's timestamps are in seconds rather than ms.
      const messages = await getChannelMessages(args.channelId, `${xDaysAgo.getTime() / 1000}`, true);
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
        ${texts.join("\n")}`;
    }
    else {
      throw new Error("Need channel or thread_ts field in event");
    }
    return await slackSummaryModel.generateContent(request);
  }
  catch (error) {
    console.error(error);
    console.error(util.inspect(error, false, null));
  }
}

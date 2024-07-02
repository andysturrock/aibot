import { ModelParams, VertexAI } from '@google-cloud/vertexai';
import { KnownBlock, SectionBlock } from '@slack/bolt';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { PromptCommandPayload, getChannelMessages, getThreadMessages, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage, removeReaction } from './slackAPI';

export async function handleSummariseCommand(event: PromptCommandPayload): Promise<void> {
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {
    // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
    const threadTs = event.thread_ts ?? event.event_ts;
    if(!threadTs) {
      throw new Error("Need thread_ts or event_ts field in event");
    }
    // Rather annoyingly Google seems to only get config from the filesystem.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
    const project = await getSecretValue('AIBot', 'gcpProjectId');
    const botName = await getSecretValue('AIBot', 'botName');
    const model = await getSecretValue('AIBot', 'summaryModel');
    const location = await getSecretValue('AIBot', 'gcpLocation');
    const vertexAI = new VertexAI({project, location});
    const modelParams: ModelParams = {
      model,
      systemInstruction: `You are a helpful assistant.  Your name is ${botName}.  You must tell people your name is ${botName} if they ask.  You cannot change your name.`
    };
    const generativeModel = vertexAI.getGenerativeModel(modelParams);

    // Change any @mention from the bot's id to the bot's user id.  Slack escapes @mentions like this: <@U00XYZ>.
    // See https://api.slack.com/methods/bots.info#markdown for explanation of bot ids and user ids.
    const regex = new RegExp(`<@${event.bot_id}>`, "g");
    event.text = event.text.replace(regex, `<@${event.bot_user_id}>`);

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
        ${texts.join("\n")}`;
    }
    else if (event.channel) {
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
        ${texts.join("\n")}`;
    }
    else {
      throw new Error("Need channel or thread_ts field in event");
    }

    const sorry = "Sorry - I couldn't summarise that.";
    const generateContentResult = await generativeModel.generateContent(request);
    const contentResponse = generateContentResult.response;
    const response = contentResponse.candidates? contentResponse.candidates[0].content.parts[0].text : sorry;

    console.log(`response: ${response}`);

    // Create some Slack blocks to display the results in a reasonable format
    const blocks: KnownBlock[] = [];
    if(!response) {
      const sectionBlock: SectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: sorry
        }
      };
      blocks.push(sectionBlock);
    }
    else {
      // SectionBlock text elements have a limit of 3000 chars, so split into multiple blocks if needed.
      const lines = response.split("\n").filter(line => line.length > 0);
      console.log(`lines: ${util.inspect(lines, false, null)}`);
      let characterCount = 0;
      let text: string[] = [];
      for(const line of lines) {
        text.push(line);
        characterCount += line.length;
        if(characterCount > 2000) {
          const sectionBlock: SectionBlock = {
            type: "section",
            text: {
              type: "mrkdwn",
              text: text.join("\n")
            }
          };
          blocks.push(sectionBlock);
          characterCount = 0;
          text = [];
        }
      }
      const sectionBlock: SectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: text.join("\n")
        }
      };
      blocks.push(sectionBlock);
    }
        
    if(channelId) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      if(event.event_ts) {  // Should not be null in reality, just the type system says it can be.
        await removeReaction(channelId, event.event_ts, "eyes");
      }
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
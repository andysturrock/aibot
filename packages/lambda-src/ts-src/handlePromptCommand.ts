import { GenerateContentResponse, ModelParams, StartChatParams, VertexAI } from '@google-cloud/vertexai';
import { KnownBlock, SectionBlock } from '@slack/bolt';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { getHistory, putHistory } from './historyTable';
import { PromptCommandPayload, getBotUserId, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage, removeReaction } from './slackAPI';

export async function handlePromptCommand(event: PromptCommandPayload): Promise<void> {
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {
    // If we are in a thread we'll respond there.  If not then we'll start a thread for the response.
    const threadTs = event.thread_ts || event.event_ts;
    if(!threadTs) {
      throw new Error("Need thread_ts or event_ts field in event");
    }
    // Rather annoyingly Google seems to only get config from the filesystem.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
    const project = await getSecretValue('AIBot', 'gcpProjectId');
    const botName = await getSecretValue('AIBot', 'botName');
    const model = await getSecretValue('AIBot', 'model');
    const location = await getSecretValue('AIBot', 'gcpLocation');
    const vertexAI = new VertexAI({project, location});
    const modelParams: ModelParams = {
      model,
      systemInstruction: `You are a helpful assistant.  Your name is ${botName}.  You must tell people your name is ${botName} if they ask.`
    };
    const generativeModel = vertexAI.getGenerativeModel(modelParams);

    // Change any @mention of the bot to the bot's name.  Slack escapes @mentions like this: <@U00XYZ>.
    // See https://api.slack.com/methods/bots.info#markdown for explanation of bot ids and user ids.
    const botUserId = await getBotUserId(event.bot_id, event.team_id);
    if(botUserId) {
      const regex = new RegExp(`<@${botUserId}>`, "g");
      event.text = event.text.replace(regex, botName);
    }
    
    const startChatParams: StartChatParams = {};
    let history = await getHistory(event.user_id, threadTs);
    startChatParams.history = history;
    const chatSession = generativeModel.startChat(startChatParams);
    const generateContentResult = await chatSession.sendMessage(event.text);
    history = await chatSession.getHistory();
    await putHistory(event.user_id, threadTs, history);
    const contentResponse: GenerateContentResponse = generateContentResult.response;
    const response = contentResponse.candidates? contentResponse.candidates[0].content.parts[0].text : "Hmmm sorry I couldn't answer that.";
    
    // Create some Slack blocks to display the results in a reasonable format
    const blocks: KnownBlock[] = [];
    const sectionBlock: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: response || "Hmmm sorry I couldn't answer that."
      }
    };
    blocks.push(sectionBlock);
        
    if(channelId) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      if(event.event_ts) {  // Should not be null in reality, just the type system says it can be.
        await removeReaction(channelId, event.event_ts, "eyes");
      }
      await postMessage(channelId, `Search results`, blocks, event.event_ts);
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
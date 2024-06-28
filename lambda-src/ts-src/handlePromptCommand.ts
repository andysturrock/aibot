import { GenerateContentResponse, VertexAI } from '@google-cloud/vertexai';
import { KnownBlock, SectionBlock } from '@slack/bolt';
import { getSecretValue } from './awsAPI';
import { PromptCommandPayload, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage } from './slackAPI';

export async function handlePromptCommand(event: PromptCommandPayload): Promise<void> {
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {

    // Rather annoyingly Google seems to only get config from the filesystem.
    process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "./clientLibraryConfig-aws-aibot.json";
    
    const gcpProjectId = await getSecretValue('AIBot', 'gcpProjectId');
    const vertexAI = new VertexAI({project: gcpProjectId, location: 'europe-west2'});
    const generativeModel = vertexAI.getGenerativeModel({
      model: 'gemini-1.5-flash-001',
    });
    // TODO load the history here
    const chatSession = generativeModel.startChat();
    const generateContentResult = await chatSession.sendMessage("Which model are you?");
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
      await postMessage(channelId, `Search results`, blocks, event.event_ts);
    }
    
  }
  catch (error) {
    console.error(error);
    if(responseUrl) {
      await postErrorMessageToResponseUrl(responseUrl, "Failed to call AI API");
    }
    else if(channelId) {
      await postEphmeralErrorMessage(channelId, event.user_id, "Failed to call AI API");
    }
  }
}
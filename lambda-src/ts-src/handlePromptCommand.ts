import {Auth} from 'googleapis';
import {getGCalToken} from './tokenStorage';
import {getSecretValue} from './awsAPI';
import {postMessage, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postToResponseUrl, SlashCommandPayload} from './slackAPI';
import {KnownBlock, SectionBlock} from '@slack/bolt';
import util from 'util';

export async function handlePromptCommand(event: SlashCommandPayload): Promise<void> {
  console.log(`event: ${util.inspect(event)}`);
  const responseUrl = event.response_url;
  const channelId = event.channel_id;
  try {
    const gcalRefreshToken = await getGCalToken(event.user_id);
    if(!gcalRefreshToken) {
      if(responseUrl) {
        await postErrorMessageToResponseUrl(responseUrl, `Log into Google, either with the slash command or the bot's Home tab.`);
      }
      else if(channelId) {
        await postEphmeralErrorMessage(channelId, event.user_id, `Log into Google, either with the slash command or the bot's Home tab.`);
      }
      return;
    }

    // User is logged into both Google so now we can use those APIs to call Vertex AI.
    const gcpClientId = await getSecretValue('AIBot', 'gcpClientId');
    const gcpClientSecret = await getSecretValue('AIBot', 'gcpClientSecret');
    const aiBotUrl = await getSecretValue('AIBot', 'aiBotUrl');
    const gcpRedirectUri = `${aiBotUrl}/google-oauth-redirect`;

    const oAuth2ClientOptions: Auth.OAuth2ClientOptions = {
      clientId: gcpClientId,
      clientSecret: gcpClientSecret,
      redirectUri: gcpRedirectUri
    };
    const oauth2Client = new Auth.OAuth2Client(oAuth2ClientOptions);
  
    oauth2Client.setCredentials({
      refresh_token: gcalRefreshToken
    });

    const blocks: KnownBlock[] = [];
    const sectionBlock: SectionBlock = {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "Hello world"
      }
    };
    blocks.push(sectionBlock);

    if(responseUrl) {
      // Use an ephemeral response if we've been called from the slash command.
      const responseType = event.command ? "ephemeral" : "in_channel";
      await postToResponseUrl(responseUrl, responseType, `Hello World from responseUrl`, blocks);
    }
    else if(channelId) {
      await postMessage(channelId, `Hello World from channelId`, blocks);
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
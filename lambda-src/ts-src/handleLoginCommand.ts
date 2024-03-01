import {generateGoogleAuthBlocks} from './generateGoogleAuthBlocks';
import {Auth} from 'googleapis';
import {getSecretValue} from './awsAPI';
import {postErrorMessageToResponseUrl, postToResponseUrl} from './slackAPI';
import {SlashCommand} from '@slack/bolt';

/**
 * Log the user into and Google and connect AIBot to those.
 * @param event the payload from the slash command
 */
export async function handleLoginCommand(event: SlashCommand): Promise<void> {
  const responseUrl = event.response_url;
  try {
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

    const googleAuthBlocks = await generateGoogleAuthBlocks(oauth2Client, event.user_id, "SlashCommand");
    await postToResponseUrl(responseUrl, "ephemeral", "Sign in to Google", googleAuthBlocks);
  }
  catch (error) {
    console.error(error);
    await postErrorMessageToResponseUrl(responseUrl, "Failed to generate Google login");
  }
}

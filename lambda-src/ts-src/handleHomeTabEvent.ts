import {AppHomeOpenedEvent, KnownBlock} from '@slack/bolt';
import {getGCalToken} from './tokenStorage';
import {publishHomeView} from './slackAPI';
import {getSecretValue} from './awsAPI';
import {Auth} from 'googleapis';
import {generateGoogleAuthBlocks, generateGoogleLogoutBlocks} from './generateGoogleAuthBlocks';

export async function handleHomeTabEvent(event: AppHomeOpenedEvent) {
  const gcalRefreshToken = await getGCalToken(event.user);
  let blocks: KnownBlock[] = [];

  if(gcalRefreshToken) {
    blocks = generateGoogleLogoutBlocks("HomeTab");
  }
  else {
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
    blocks = await generateGoogleAuthBlocks(oauth2Client, event.user, "HomeTab");
  }
  await publishHomeView(event.user, blocks);
}

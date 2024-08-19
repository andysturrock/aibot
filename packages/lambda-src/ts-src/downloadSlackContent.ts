import util from 'util';
import { getSecretValue } from './awsAPI';
import {
  getChannelMessagesUsingToken,
  getPublicChannels
} from './slackAPI';

export async function downloadSlackContent() {
  const slackUserToken = await getSecretValue('AIBot', 'slackUserToken');
  const channelId = "C06RLR75MMH";
  const days = 365;
  const xDaysAgo = new Date(new Date().getTime() - (days * 24 * 60 * 60 * 1000));

  // const publicChannels = await getPublicChannelsUsingToken(slackUserToken, "E04KL4D7HBP") ?? [];
  const publicChannels = await getPublicChannels("E04KL4D7HBP") ?? [];
  
  console.log(`publicChannels: ${util.inspect(publicChannels, false, null)}`);
  const messages = await getChannelMessagesUsingToken(slackUserToken, channelId, `${xDaysAgo.getTime() / 1000}`, true);

  console.log(`messages: ${util.inspect(messages, false, null)}`);  
}

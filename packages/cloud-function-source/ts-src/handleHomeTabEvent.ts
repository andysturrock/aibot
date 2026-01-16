import { ActionsBlock, AppHomeOpenedEvent, KnownBlock, MrkdwnElement, SectionBlock } from '@slack/types';
import { getSecretValue } from './gcpAPI';
import { publishHomeView } from './slackAPI';
import { getAccessToken } from './gcpTokensTable';

export async function handleHomeTabEvent(event: AppHomeOpenedEvent) {
  const blocks: KnownBlock[] = [];

  const botName = await getSecretValue('AIBot', 'botName');

  const accessToken = await getAccessToken(event.user);

  if (accessToken) {
    const mrkdwnElement: MrkdwnElement = {
      type: 'mrkdwn',
      text: `You are authorised with ${botName}`
    };
    const sectionBlock: SectionBlock = {
      type: 'section',
      text: mrkdwnElement
    };
    blocks.push(sectionBlock);
  }
  else {
    const authUrl = await getSecretValue('AIBot', 'authUrl');

    const mrkdwnElement: MrkdwnElement = {
      type: 'mrkdwn',
      text: `You are not authorised with ${botName}.  Use the button below to authorise.`
    };
    const sectionBlock: SectionBlock = {
      type: 'section',
      text: mrkdwnElement
    };
    blocks.push(sectionBlock);
    const actionsBlock: ActionsBlock = {
      type: "actions",
      block_id: "authButton",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `Authorise ${botName}`
          },
          url: authUrl,
          style: "primary",
          action_id: 'authButton'
        }
      ]
    };
    blocks.push(actionsBlock);
  }

  await publishHomeView(event.user, blocks);
}

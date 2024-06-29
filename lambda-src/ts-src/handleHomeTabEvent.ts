import { AppHomeOpenedEvent, KnownBlock, MrkdwnElement, SectionBlock } from '@slack/bolt';
import { publishHomeView } from './slackAPI';

export async function handleHomeTabEvent(event: AppHomeOpenedEvent) {
  const blocks: KnownBlock[] = [];

  const mrkdwnElement: MrkdwnElement = {
    type: 'mrkdwn',
    text: 'Placeholder'
  };
  const sectionBlock: SectionBlock = {
    type: 'section',
    text: mrkdwnElement
  };
  blocks.push(sectionBlock);
  await publishHomeView(event.user, blocks);
}

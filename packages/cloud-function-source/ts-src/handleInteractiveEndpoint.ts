import { BlockAction } from '@slack/bolt/dist/types/actions';
import { KnownBlock, MrkdwnElement, SectionBlock } from "@slack/types";
import { publishHomeView } from "./slackAPI";

/**
 * Handle the interaction payloads from Slack.
 * @param payload the parsed JSON payload from Slack
 */
export async function handleInteractiveEndpoint(payload: any): Promise<void> {
  try {
    type ActionType = {
      type: string
    };
    const actionPayload = payload as ActionType;

    switch (actionPayload.type) {
      case "block_actions": {
        const blockAction: BlockAction = payload as BlockAction;
        await handleBlockAction(blockAction);
        break;
      }
    }
  }
  catch (error) {
    console.error("Error in handleInteractiveEndpoint:", error);
  }
}

async function handleBlockAction(blockAction: BlockAction) {
  // Update the Home tab to say we are authorising
  if (blockAction.actions[0].action_id === "authButton") {
    const blocks: KnownBlock[] = [];
    const mrkdwnElement: MrkdwnElement = {
      type: 'mrkdwn',
      text: "Authorising..."
    };
    const sectionBlock: SectionBlock = {
      type: 'section',
      text: mrkdwnElement
    };
    blocks.push(sectionBlock);
    await publishHomeView(blockAction.user.id, blocks);
  }
}
import { BlockAction, KnownBlock, MrkdwnElement, SectionBlock } from "@slack/bolt";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getSecretValue } from './awsAPI';
import { publishHomeView } from "./slackAPI";
import { verifySlackRequest } from './verifySlackRequest';

/**
 * Handle the interaction posts from Slack.
 * @param event the event from Slack containing the interaction payload
 * @returns HTTP 200 back to Slack immediately to indicate the interaction payload has been received.
 */
export async function handleInteractiveEndpoint(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if(!event.body) {
      throw new Error("Missing event body");
    }

    // Verify that this request really did come from Slack
    const signingSecret = await getSecretValue('AIBot', 'slackSigningSecret');
    verifySlackRequest(signingSecret, event.headers, event.body);

    let body = decodeURIComponent(event.body);
    // For some reason the body parses to "payload= {...}"
    // so remove the bit outside the JSON
    body = body.replace('payload=', '');
    type ActionType = {
      type: string
    };
    const payload = JSON.parse(body) as ActionType;

    switch(payload.type) {
      case "block_actions": {
        const blockAction: BlockAction = payload as BlockAction;
        await handleBlockAction(blockAction);
        break;
      }
    }

    const result: APIGatewayProxyResult = {
      body: JSON.stringify({msg: "ok"}),
      statusCode: 200
    };

    return result;
  }
  catch (error) {
    console.error(error);
    const result: APIGatewayProxyResult = {
      body: "Error",
      statusCode: 200 // 200 because we received the event, just couldn't deal with it properly.
    };
    return result;
  }
}

async function handleBlockAction(blockAction: BlockAction) {
  // Update the Home tab to say we are authorising
  if(blockAction.actions[0].action_id === "authButton") {
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
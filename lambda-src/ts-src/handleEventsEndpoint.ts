import { AppHomeOpenedEvent, EnvelopedEvent, GenericMessageEvent } from '@slack/bolt';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import util from 'util';
import { getSecretValue, invokeLambda } from './awsAPI';
import { PromptCommandPayload, addReaction, getBotId } from './slackAPI';
import { verifySlackRequest } from './verifySlackRequest';

/**
 * Handle the event posts from Slack.
 * @param event the event from Slack containing the event payload
 * @returns HTTP 200 back to Slack immediately to indicate the event payload has been received.
 */
export async function handleEventsEndpoint(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log(`event: ${util.inspect(event, false, null)}`);
  try {
    if(!event.body) {
      throw new Error("Missing event body");
    }

    // Verify that this request really did come from Slack
    const signingSecret = await getSecretValue('AIBot', 'slackSigningSecret');
    verifySlackRequest(signingSecret, event.headers, event.body);

    const result: APIGatewayProxyResult = {
      body: JSON.stringify({msg: "ok"}),
      statusCode: 200
    };

    const envelopedEvent = JSON.parse(event.body) as EnvelopedEvent;
    switch(envelopedEvent.event.type) {
    // DM from the Messages tab or @mention
    case "message":
    case "app_mention":{
      const genericMessageEvent = envelopedEvent.event as GenericMessageEvent;
      // Get our own user ID and ignore messages we have posted, otherwise we'll get into an infinite loop.
      const myId = await getBotId();
      if(!myId) {
        throw new Error("Cannot get bot's own user id");
      }
      if(genericMessageEvent.bot_id === myId) {
        console.debug(`Ignoring message from self ${myId}`);
        return result;
      }

      // We need to respond within 3000ms so add an eyes emoji to the user's message to show we are looking it.
      // Then call the AIBot-handlePromptCommandLambda asynchronously.
      await addReaction(genericMessageEvent.channel, genericMessageEvent.event_ts, "eyes");

      if(!genericMessageEvent.text) {
        throw new Error("No text in message");
      }
      const promptCommandPayload: PromptCommandPayload = {
        text: genericMessageEvent.text, // Can be null in GenericMessageEvent but we have checked above.
        user_id: genericMessageEvent.user,  // Slack seems a bit inconsistent with user vs user_id
        ...genericMessageEvent,
        bot_id: myId,
        team_id: envelopedEvent.team_id
      };
      await invokeLambda("AIBot-handlePromptCommandLambda", JSON.stringify(promptCommandPayload));
      break;
    }
    case "app_home_opened": {
      const appHomeOpenedEvent: AppHomeOpenedEvent = envelopedEvent.event as AppHomeOpenedEvent;
      // Slightly strangely AppHomeOpenedEvent is fired for when the user opens either Messages or Home tab.
      if(appHomeOpenedEvent.tab === "home") {
        await invokeLambda("AIBot-handleHomeTabEventLambda", JSON.stringify(appHomeOpenedEvent));
      }
      break;
    }

    case "url_verification": {
      // This handles the initial event API verification.
      // See https://api.slack.com/events/url_verification
      type URLVerification = {
        token:string;
        challenge: string;
        type: string;
      };
      const urlVerification = JSON.parse(event.body) as URLVerification;
      if(urlVerification.type === "url_verification") {
        result.body = JSON.stringify({
          challenge: urlVerification.challenge
        });
        result.headers = {
          'Content-Type': 'application/json',
        };
      }
      break;
    }
    
    default:
      console.warn(`Unexpected event type: ${envelopedEvent.event.type}`);
      break;
    }

    return result;
  }
  catch (error) {
    console.error(error);

    const result: APIGatewayProxyResult = {
      body: "There was an error - please check the logs",
      statusCode: 200
    };
    return result;
  }
}

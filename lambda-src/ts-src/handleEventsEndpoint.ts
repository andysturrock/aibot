import {APIGatewayProxyEvent, APIGatewayProxyResult} from "aws-lambda";
import {getSecretValue, invokeLambda} from './awsAPI';
import {verifySlackRequest} from './verifySlackRequest';
import {PromptCommandPayload, getBotId, postEphemeralMessage} from './slackAPI';
import {AppHomeOpenedEvent, EnvelopedEvent, GenericMessageEvent} from '@slack/bolt';
import {generateImmediateSlackResponseBlocks} from './generateImmediateSlackResponseBlocks';

/**
 * Handle the event posts from Slack.
 * @param event the event from Slack containing the event payload
 * @returns HTTP 200 back to Slack immediately to indicate the event payload has been received.
 */
export async function handleEventsEndpoint(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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
      return result;
    }

    // Maybe we're getting a DM from the Messages tab
    const envelopedEvent = JSON.parse(event.body) as EnvelopedEvent;
    if(envelopedEvent.event.type === "message") {
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

      // We need to respond within 3000ms so post an ephemeral message and then
      // call the AIBot-handlePromptCommandLambda asynchronously.
      const blocks = generateImmediateSlackResponseBlocks();
      await postEphemeralMessage(genericMessageEvent.channel, genericMessageEvent.user, "Thinking...", blocks);

      if(!genericMessageEvent.text) {
        throw new Error("No text in message");
      }
      const promptCommandPayload: PromptCommandPayload = {
        text: genericMessageEvent.text, // Can be null in GenericMessageEvent but we have checked above.
        user_id: genericMessageEvent.user,  // Slack seems a bit inconsistent with user vs user_id
        ...genericMessageEvent
      };
      await invokeLambda("AIBot-handlePromptCommandLambda", JSON.stringify(promptCommandPayload));
    }
    // Else the user has opened the Home tab
    else if(envelopedEvent.event.type === "app_home_opened") {
      const appHomeOpenedEvent: AppHomeOpenedEvent = envelopedEvent.event as AppHomeOpenedEvent;
      // Slightly strangely AppHomeOpenedEvent is fired for when the user opens either Messages or Home tab.
      if(appHomeOpenedEvent.tab === "home") {
        await invokeLambda("AIBot-handleHomeTabEventLambda", JSON.stringify(appHomeOpenedEvent));
      }
    }
    else {
      console.warn(`Unexpexted event type: ${envelopedEvent.event.type}`);
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

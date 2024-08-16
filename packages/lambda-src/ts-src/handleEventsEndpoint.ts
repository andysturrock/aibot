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
    case "app_mention": {
      const genericMessageEvent = envelopedEvent.event as GenericMessageEvent;
      // Get our own user ID and ignore messages we have posted, otherwise we'll get into an infinite loop.
      const myId = await getBotId();
      if(!myId.bot_id || !myId.bot_user_id) {
        throw new Error("Cannot get bot's own user id");
      }
      if(genericMessageEvent.bot_id === myId.bot_id) {
        console.debug(`Ignoring message from self ${myId.bot_id} or ${myId.bot_user_id}`);
        return result;
      }
      const ignoreMessagesFromTheseIds = (await getSecretValue('AIBot', 'ignoreMessagesFromTheseIds')).split(",");
      if(ignoreMessagesFromTheseIds.some(id => id == genericMessageEvent.user)) {
        console.debug(`Ignoring message from ${genericMessageEvent.user} as it's in the ignore list ${util.inspect(ignoreMessagesFromTheseIds, false, null)}`);
        console.debug(`Message was ${genericMessageEvent.text}`);
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
        bot_id: myId.bot_id,
        bot_user_id: myId.bot_user_id,
        team_id: envelopedEvent.team_id
      };

      // Change any @mention from the bot's id to the bot's user id.  Slack escapes @mentions like this: <@U00XYZ>.
      // See https://api.slack.com/methods/bots.info#markdown for explanation of bot ids and user ids.
      const regex = new RegExp(`<@${myId.bot_id}>`, "g");
      genericMessageEvent.text = genericMessageEvent.text.replace(regex, `<@${myId.bot_user_id}>`);

      // If the user has asked for a summary, dispatch to that lambda.
      // In a thread or channel the user will use "@bot summarise" so use a regex to match that.
      // Note the double \\ to escape \s
      if(genericMessageEvent.text.match(new RegExp(`<@${myId.bot_user_id}>\\ssummarise`)) ??
          genericMessageEvent.text.match(new RegExp(`<@${myId.bot_user_id}>\\slumos`))) {
        await invokeLambda("AIBot-handleSummariseCommandLambda", JSON.stringify(promptCommandPayload));
      }
      else {
        await invokeLambda("AIBot-handlePromptCommandLambda", JSON.stringify(promptCommandPayload));
      }
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

import * as util from 'util';
import {APIGatewayProxyEvent, APIGatewayProxyResult} from "aws-lambda";
import {getSecretValue} from './awsAPI';
import {verifySlackRequest} from './verifySlackRequest';
import {PromptCommandPayload, getBotId, postEphemeralMessage} from './slackAPI';
import {EnvelopedEvent, GenericMessageEvent} from '@slack/bolt';
import {InvocationType, InvokeCommand, InvokeCommandInput, LambdaClient, LambdaClientConfig} from '@aws-sdk/client-lambda';
import {generateImmediateSlackResponseBlocks} from './generateImmediateSlackResponseBlocks';

/**
 * Handle the event posts from Slack.
 * @param event the event from Slack containing the event payload
 * @returns HTTP 200 back to Slack immediately to indicate the event payload has been received.
 */
export async function handleEventsEndpoint(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    console.log(`event: ${util.inspect(event)}`);
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
      console.log(`result: ${util.inspect(result)}`);
      return result;
    }

    // If it's not that then we're getting a DM from the Messages tab
    const envelopedEvent = JSON.parse(event.body) as EnvelopedEvent;
    console.log(`envelopedEvent: ${util.inspect(envelopedEvent, false, null)}`);
    if(envelopedEvent.event.type === "message") {
      const genericMessageEvent = envelopedEvent.event as GenericMessageEvent;
      // Get our own user ID and ignore messages we have posted, otherwise we'll get into an infinite loop.
      const myId = await getBotId();
      if(!myId) {
        throw new Error("Cannot get bot's own user id");
      }
      if(genericMessageEvent.bot_id === myId) {
        console.log(`Ignoring message from self ${myId}`);
        return result;
      }

      // We need to respond within 3000ms so post an ephemeral message and then
      // call the AIBot-handlePromptCommandLambda asynchronously.
      const blocks = generateImmediateSlackResponseBlocks();
      await postEphemeralMessage(genericMessageEvent.channel, genericMessageEvent.user, "Thinking...", blocks);

      const configuration: LambdaClientConfig = {
        region: 'eu-west-2'
      };
      const functionName = "AIBot-handlePromptCommandLambda";
      if(!genericMessageEvent.text) {
        throw new Error("No text in message");
      }
      const promptCommandPayload: PromptCommandPayload = {
        text: genericMessageEvent.text, // Can be null in GenericMessageEvent but we have checked above.
        user_id: genericMessageEvent.user,  // Slack seems a bit inconsistent with user vs user_id
        ...genericMessageEvent
      };
      const lambdaClient = new LambdaClient(configuration);
      const input: InvokeCommandInput = {
        FunctionName: functionName,
        InvocationType: InvocationType.Event,
        Payload: new TextEncoder().encode(JSON.stringify(promptCommandPayload))
      };
  
      const invokeCommand = new InvokeCommand(input);
      const output = await lambdaClient.send(invokeCommand);
      if(output.StatusCode != 202) {
        throw new Error(`Failed to invoke ${functionName} - error:${util.inspect(output.FunctionError)}`);
      }
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

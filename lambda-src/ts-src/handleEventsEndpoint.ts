import * as util from 'util';
import {APIGatewayProxyEvent, APIGatewayProxyResult} from "aws-lambda";
import {getSecretValue} from './awsAPI';
import {verifySlackRequest} from './verifySlackRequest';
import {SlashCommandPayload, getBotId, postEphemeralMessage, postMessage} from './slackAPI';
import {Block, EnvelopedEvent, SectionBlock, GenericMessageEvent} from '@slack/bolt';
import {Auth} from 'googleapis';
import {generateGoogleAuthBlocks} from './generateGoogleAuthBlocks';
import {InvocationType, InvokeCommand, InvokeCommandInput, LambdaClient, LambdaClientConfig} from '@aws-sdk/client-lambda';

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
      
      console.log(`envelopedEvent: ${util.inspect(envelopedEvent, false, null)}`);
      // We need to respond within 3000ms so post an ephemeral message and then
      // call the AIBot-handlePromptCommandLambda asynchronously.
      const blocks: Block[] = [];
      const sectionBlock: SectionBlock = {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "Thinking..."
        }
      };
      blocks.push(sectionBlock);
      await postEphemeralMessage(genericMessageEvent.channel, genericMessageEvent.user, "Thinking...", blocks);

      const configuration: LambdaClientConfig = {
        region: 'eu-west-2'
      };
      const functionName = "AIBot-handlePromptCommandLambda";
      if(!genericMessageEvent.text) {
        throw new Error("No text in message");
      }
      const slashCommandPayload: SlashCommandPayload = {
        text: genericMessageEvent.text,
        token: '',
        team_id: '',
        team_domain: '',
        channel_id: genericMessageEvent.channel,
        channel_name: '',
        user_id: genericMessageEvent.user,
        user_name: '',
        command: '',
        api_app_id: envelopedEvent.api_app_id,
        is_enterprise_install: '',
        response_url: '',
        trigger_id: ''
      };
      const lambdaClient = new LambdaClient(configuration);
      const input: InvokeCommandInput = {
        FunctionName: functionName,
        InvocationType: InvocationType.Event,
        Payload: new TextEncoder().encode(JSON.stringify(slashCommandPayload))
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

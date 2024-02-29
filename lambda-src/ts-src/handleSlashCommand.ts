import {InvocationType, InvokeCommand, InvokeCommandInput, LambdaClient, LambdaClientConfig} from "@aws-sdk/client-lambda";
import {generateImmediateSlackResponseBlocks} from './generateImmediateSlackResponseBlocks';
import querystring from 'querystring';
import util from 'util';
import {APIGatewayProxyEvent, APIGatewayProxyResult} from "aws-lambda";
import {verifySlackRequest} from "./verifySlackRequest";
import {getSecretValue} from "./awsAPI";
import {PromptCommandPayload, SlashCommandPayload} from "./slackAPI";
import {getGCalToken} from "./tokenStorage";

export async function handleSlashCommand(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if(!event.body) {
      throw new Error("Missing event body");
    }
    const body = querystring.parse(event.body) as unknown as SlashCommandPayload;

    const signingSecret = await getSecretValue('AIBot', 'slackSigningSecret');

    // Verify that this request really did come from Slack
    verifySlackRequest(signingSecret, event.headers, event.body);

    // We need to send an immediate response within 3000ms.
    // So this lambda will invoke another one to do the real work.
    // It will use the response_url which comes from the body of the event param.
    // Here we just return an interim result with a 200 code.
    // See https://api.slack.com/interactivity/handling#acknowledgment_response
    const blocks = generateImmediateSlackResponseBlocks();
    const resultBody = {
      response_type: "ephemeral",
      blocks
    };
    const result: APIGatewayProxyResult = {
      body: JSON.stringify(resultBody),
      statusCode: 200
    };

    // Dispatch to the appropriate lambda depending on args passed to the Slash command
    // and whether we are logged into and Google
    console.log(`Text: <${body.text}>`);
    const slashCommandOptions = body.text.length == 0 ? "" : body.text;
    let functionName = "AIBot-handlePromptCommandLambda";
    const gcalRefreshToken = await getGCalToken(body.user_id);
    let payload: PromptCommandPayload | SlashCommandPayload;

    if(!gcalRefreshToken || slashCommandOptions === "login") {
      functionName = "AIBot-handleLoginCommandLambda";
      payload = body;
    }
    else if(slashCommandOptions === "logout") {
      functionName = "AIBot-handleLogoutCommandLambda";
      payload = body;
    }
    else {
      const promptCommandPayload: PromptCommandPayload = {
        ...body
      };
      payload = promptCommandPayload;
    }

    const configuration: LambdaClientConfig = {
      region: 'eu-west-2'
    };

    const lambdaClient = new LambdaClient(configuration);
    const input: InvokeCommandInput = {
      FunctionName: functionName,
      InvocationType: InvocationType.Event,
      Payload: new TextEncoder().encode(JSON.stringify(payload))
    };

    const invokeCommand = new InvokeCommand(input);
    const output = await lambdaClient.send(invokeCommand);
    if(output.StatusCode != 202) {
      throw new Error(`Failed to invoke ${functionName} - error:${util.inspect(output.FunctionError)}`);
    }

    return result;
  }
  catch (error) {
    console.error(`Caught error: ${util.inspect(error)}`);
    return createErrorResult("There was an error.  Please contact support.");
  }
}

function createErrorResult(text: string) {
  const resultBody = {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text
        }
      }
    ]
  };
  const result: APIGatewayProxyResult = {
    body: JSON.stringify(resultBody),
    statusCode: 200
  };
  return result;
}
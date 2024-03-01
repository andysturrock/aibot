import * as util from 'util';
import {APIGatewayProxyEvent, APIGatewayProxyResult} from "aws-lambda";
import {verifySlackRequest} from './verifySlackRequest';
import axios from 'axios';
import {getSecretValue, invokeLambda} from './awsAPI';
import {AppHomeOpenedEvent, BlockAction, KnownBlock, SectionBlock, SlashCommand} from '@slack/bolt';
import {handleLogoutCommand} from './handleLogoutCommand';
import {publishHomeView} from './slackAPI';

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
    const payload = JSON.parse(body) as BlockAction;

    // TODO assume we only get one Action for now
    if(payload.actions[0].action_id === "googleSignInButtonSlashCommand") {
      // If this is from the slash command then delete the original login card
      // as it can't be used again without appearing like a CSRF replay attack.
      // Use the POST api as per https://api.slack.com/interactivity/handling#deleting_message_response
      // chat.delete doesn't seem to work here.
      await axios.post(payload.response_url, {delete_original: "true"});
    }
    else if(payload.actions[0].action_id === "googleSignInButtonHomeTab") {
      // The handleGoogleAuthRedirect lambda does almost everything, but we need to remove
      // the sign in button so the user can't press it twice.
      const blocks: KnownBlock[] = [];
      const sectionBlock: SectionBlock = {
        type: "section",
        fields: [
          {
            type: "plain_text",
            text: "Signing in to Google..."
          }
        ]
      };
      blocks.push(sectionBlock);
      await publishHomeView(payload.user.id, blocks);
    }
    else if(payload.actions[0].action_id === "googleSignOutButtonHomeTab") {
      // Remove the button so the user can't click it twice.
      const blocks: KnownBlock[] = [];
      const sectionBlock: SectionBlock = {
        type: "section",
        fields: [
          {
            type: "plain_text",
            text: "Signing out of Google..."
          }
        ]
      };
      blocks.push(sectionBlock);
      await publishHomeView(payload.user.id, blocks);
      // Invoke the handleLogoutCommandLambda to do the logout.
      // It will in turn invoke the handleHomeTabEvent when it's done.
      const slashCommand: SlashCommand = {
        ...payload,
        // Quite annoying that Slack's own types aren't consistent.
        is_enterprise_install: payload.is_enterprise_install? "true" : "false",
        command: '',
        text: '',
        user_id: payload.user.id,
        user_name: '',
        team_id: '',
        team_domain: '',
        channel_id: '',
        channel_name: ''
      };
      await invokeLambda("AIBot-handleLogoutCommandLambda", JSON.stringify(slashCommand));
    }
    else 
    {
      // TODO handle other interactive commands if necessary
      console.warn(`Unknown action: ${payload.actions[0].action_id}`);
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

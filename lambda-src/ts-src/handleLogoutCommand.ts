import {postErrorMessageToResponseUrl, postToResponseUrl} from './slackAPI';
import {AppHomeOpenedEvent, KnownBlock, SlashCommand} from '@slack/bolt';
import {deleteGCalToken} from './tokenStorage';
import {invokeLambda} from './awsAPI';

/**
 * Remove the connection between AIBot and Google.
 * Note this doesn't log the user out from Google.
 * @param event Payload of the slash command
 */
export async function handleLogoutCommand(event: SlashCommand): Promise<void> {
  const responseUrl = event.response_url;

  try {
    await deleteGCalToken(event.user_id);

    // May have been called from button on Home tab which won't have a response url
    if(responseUrl) {
      const blocks: KnownBlock[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Logged out successfully"
          }
        }
      ];
      await postToResponseUrl(responseUrl, "ephemeral", "Logged out successfully", blocks);
    }
    else {
      // Fire the handleHomeTabEvent lambda to update the home tab.
      const appHomeOpenedEvent: AppHomeOpenedEvent = {
        type: 'app_home_opened',
        user: event.user_id,
        channel: event.channel_id,
        event_ts: ''
      };
      await invokeLambda("AIBot-handleHomeTabEventLambda", JSON.stringify(appHomeOpenedEvent));
    }
  }
  catch (error) {
    console.error(error);
    await postErrorMessageToResponseUrl(responseUrl, "Failed to log out of Google");
  }
}

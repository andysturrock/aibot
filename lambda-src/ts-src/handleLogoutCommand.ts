import {SlashCommandPayload, postErrorMessageToResponseUrl, postToResponseUrl} from './slackAPI';
import {KnownBlock} from '@slack/bolt';
import {deleteGCalToken} from './tokenStorage';

/**
 * Remove the connection between AIBot and Google.
 * Note this doesn't log the user out from Google.
 * @param event Payload of the slash command
 */
export async function handleLogoutCommand(event: SlashCommandPayload): Promise<void> {
  const responseUrl = event.response_url;

  try {
    await deleteGCalToken(event.user_id);

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
  catch (error) {
    console.error(error);
    await postErrorMessageToResponseUrl(responseUrl, "Failed to log out of Google");
  }
}

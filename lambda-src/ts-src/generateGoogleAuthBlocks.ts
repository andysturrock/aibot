import {Auth} from 'googleapis';
import crypto from 'crypto';
import {State, putState} from './stateTable';
import {ActionsBlock, KnownBlock, SectionBlock} from '@slack/bolt';

/**
 * Generate a button for Google login.
 * CSRF replay attacks are mitigated by using a nonce as the state param in the redirect URL.
 * The state is the primary key to the info in the AIBot_State table which is then queried in the redirect handler.
 * @param oauth2Client Initialised Google SDK OAuth2Client object
 * @param slack_user_id Slack user id for the user signing in
 * @param response_url Response URL for use in the redirect handler to send messages to the Slack user
 * @returns blocks containing the "Sign in to Google" button
 */
export async function generateGoogleAuthBlocks(oauth2Client: Auth.OAuth2Client, slack_user_id: string, source: "SlashCommand" | "HomeTab") {
  const scopes = [
    'profile', 'https://www.googleapis.com/auth/cloud-platform'
  ];

  // Using a nonce for the state mitigates CSRF attacks.
  const nonce = crypto.randomBytes(16).toString('hex');
  const state: State = {
    nonce,
    slack_user_id
  };

  await putState(nonce, state);

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes.join(' '),
    state: nonce,
    prompt: 'consent'
  });

  const blocks: KnownBlock[] = [];
  const sectionBlock: SectionBlock = {
    type: "section",
    fields: [
      {
        type: "plain_text",
        text: "Sign in to Google"
      }
    ]
  };
  blocks.push(sectionBlock);
  const actionsBlock: ActionsBlock = {
    type: "actions",
    block_id: "signInButton",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Sign in to Google"
        },
        url,
        style: "primary",
        action_id: `googleSignInButton${source}`
      }
    ]
  };
  blocks.push(actionsBlock);
  return blocks;
}

export function generateGoogleLogoutBlocks(source: "SlashCommand" | "HomeTab") {
  const blocks: KnownBlock[] = [];
  const sectionBlock: SectionBlock = {
    type: "section",
    fields: [
      {
        type: "plain_text",
        text: "Sign in to Google"
      }
    ]
  };
  blocks.push(sectionBlock);
  const actionsBlock: ActionsBlock = {
    type: "actions",
    block_id: "signInButton",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Sign out of Google"
        },
        style: "primary",
        action_id: `googleSignOutButton${source}`
      }
    ]
  };
  blocks.push(actionsBlock);
  return blocks;
}
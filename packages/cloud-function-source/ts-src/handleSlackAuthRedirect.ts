import { KnownBlock, MrkdwnElement, SectionBlock } from "@slack/types";
import { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import querystring from 'querystring';
import { getSecretValue } from "./gcpAPI";
import { publishHomeView } from "./slackAPI";
import { putAccessToken } from "./gcpTokensTable";

/**
 * Handle the Slack OAuth redirect.
 */
export async function handleSlackAuthRedirect(req: Request, res: Response): Promise<void> {
  try {
    const slackClientId = await getSecretValue('AIBot', 'slackClientId');
    const slackClientSecret = await getSecretValue('AIBot', 'slackClientSecret');

    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Missing code in redirect");
      return;
    }

    const config: AxiosRequestConfig = {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    };
    const url = "https://slack.com/api/oauth.v2.access";
    const form = querystring.stringify({
      code,
      client_id: slackClientId,
      client_secret: slackClientSecret
    });

    type SlackResponse = {
      ok: boolean,
      app_id: string,
      authed_user: {
        id: string,
        access_token: string
      },
      scope: string,
      token_type: string,
      access_token: string,
      bot_user_id: string,
      team?: { id: string, name: string },
      enterprise?: { id: string, name: string },
      is_enterprise_install: boolean,
      error?: string
    };
    const { data } = await axios.post<SlackResponse>(url, form, config);

    if (!data.ok) {
      throw new Error(`Failed to exchange token: ${data.error}`);
    }

    await putAccessToken(data.authed_user.id, data.authed_user.access_token);
    let successText = `Successfully installed AIBot in workspace`;
    if (data.team?.name) {
      successText = `Successfully installed AIBot in workspace ${data.team.name}`;
    }
    else if (data.enterprise?.name) {
      successText = `Successfully installed AIBot in organisation ${data.enterprise.name}`;
    }

    // Update the Home tab to say we are authorised.
    const botName = await getSecretValue('AIBot', 'botName');
    const blocks: KnownBlock[] = [];
    const mrkdwnElement: MrkdwnElement = {
      type: 'mrkdwn',
      text: `You are authorised with ${botName}`
    };
    const sectionBlock: SectionBlock = {
      type: 'section',
      text: mrkdwnElement
    };
    blocks.push(sectionBlock);
    await publishHomeView(data.authed_user.id, blocks);

    const html = `
<!DOCTYPE html>
<html>
<body>
<h1>Installation Success</h1>
<p>${successText}</p>
</body>
</html>
    `;

    res.status(200).set('Content-Type', 'text/html').send(html);
  }
  catch (error: any) {
    console.error("Auth Redirect Error:", error);
    const html = `
<!DOCTYPE html>
<html>
<body>
<h1>Installation Failure</h1>
<p>There was an error: ${error.message}</p>
</body>
</html>
    `;
    res.status(200).set('Content-Type', 'text/html').send(html);
  }
}

import { App, ExpressReceiver, SlackActionMiddlewareArgs, SlackEventMiddlewareArgs, AnyMiddlewareArgs } from '@slack/bolt';
import { getSecretValue, publishToTopic } from './gcpAPI.js';
import { handleInteractiveEndpoint } from './handleInteractiveEndpoint.js';
import { handleHomeTabEvent } from './handleHomeTabEvent.js';
import { handlePromptCommand } from './handlePromptCommand.js';
import { handleSlackAuthRedirect } from './handleSlackAuthRedirect.js';
import { getBotId, addReaction, PromptCommandPayload } from './slackAPI.js';
import { Request, Response } from 'express';
import dotenv from 'dotenv';
import util from 'node:util';

dotenv.config();

const PORT = Number(process.env.PORT) || 8080;

/**
 * Service B: Worker App (Logic)
 * This app instance processes events rehydrated from Pub/Sub.
 */
const workerApp = new App({
  token: "placeholder", // Set in startApp
  signingSecret: "placeholder",
  receiver: undefined
});

// Worker Logic for app_mention
workerApp.event('app_mention', async ({ event, context }: any) => {
  try {
    const myId = await getBotId();
    const ignoreList = (await getSecretValue('AIBot', 'ignoreMessagesFromTheseIds')).split(",");

    if (event.bot_id === myId.bot_id || (event.user && ignoreList.includes(event.user))) {
      return;
    }

    await addReaction(event.channel, event.event_ts, "eyes");

    const myBotId = myId.bot_id || "";
    const myBotUserId = myId.bot_user_id || "";

    const promptCommandPayload: PromptCommandPayload = {
      ...event,
      type: 'message', // GenericMessageEvent expects 'message'
      channel_type: 'im',
      user: event.user || "",
      user_id: event.user || "",
      bot_id: myBotId,
      bot_user_id: myBotUserId,
      team_id: (context as any).teamId || (event as any).team || "",
    } as any; // Cast to avoid deep type intersection issues with Slack SDK

    const regex = new RegExp(`<@${myBotId}>`, "g");
    promptCommandPayload.text = (event.text || "").replace(regex, `<@${myBotUserId}>`);

    await handlePromptCommand(promptCommandPayload);
  } catch (error) {
    console.error("Error in app_mention handler:", error);
  }
});

// Worker Logic for app_home_opened
workerApp.event('app_home_opened', async ({ event }: SlackEventMiddlewareArgs<'app_home_opened'>) => {
  try {
    if (event.tab === "home") {
      await handleHomeTabEvent(event as any);
    }
  } catch (error) {
    console.error("Error in app_home_opened handler:", error);
  }
});

// Worker Logic for interactions (block_actions)
workerApp.action(/.*/, async ({ body }: SlackActionMiddlewareArgs) => {
  // Service B worker doesn't need to ack (already acked by Service A)
  await handleInteractiveEndpoint(body);
});

async function startApp() {
  const signingSecret = await getSecretValue('AIBot', 'slackSigningSecret');
  const botToken = await getSecretValue('AIBot', 'slackBotToken');

  // Update worker app with real token
  (workerApp as any).client.token = botToken;

  /**
   * Service A: Webhook Receiver
   * Thin entry point that pushes to Pub/Sub
   */
  const receiver = new ExpressReceiver({
    signingSecret,
    endpoints: '/slack/events',
    processBeforeResponse: true
  });

  const app = new App({
    token: botToken,
    receiver
  });

  // Service A middleware: Security Whitelist + Pub/Sub + Ack
  app.use(async ({ body, ack }: AnyMiddlewareArgs) => {
    const allowedTeamIds = (await getSecretValue('AIBot', 'teamIdsForSearch')).split(",");
    const payload = body as any;
    const teamId = payload.team_id || payload.enterprise_id || (payload.event && (payload.event.team || payload.event.user_team)) || (payload.team && payload.team.id);

    if (!teamId || !allowedTeamIds.includes(teamId)) {
      console.warn(`Unauthorized or unidentified team ID: ${teamId}`);
      if (payload.type !== "url_verification") {
        return; // Drop the request
      }
    }

    const topicId = process.env.TOPIC_ID || "slack-events";
    await publishToTopic(topicId, JSON.stringify(payload));
    if (ack) {
      await ack();
    }
  });

  // OAuth Redirect (Synchronous)
  receiver.app.get('/slack/oauth/redirect', (req: Request, res: Response) => handleSlackAuthRedirect(req, res));

  /**
   * Service B: Worker Entry Point
   * Triggered by Pub/Sub Push
   */
  receiver.app.post('/pubsub/worker', async (req: Request, res: Response) => {
    try {
      const message = req.body.message;
      if (!message || !message.data) {
        res.status(400).send("Invalid Pub/Sub message");
        return;
      }

      const payloadStr = Buffer.from(message.data, 'base64').toString();
      const payload = JSON.parse(payloadStr);

      console.log("Worker receiving rehydrated event:", payload.type || payload.event?.type);

      // Rehydrate into workerApp for routing
      await workerApp.processEvent(payload);

      res.status(200).send("OK");
    } catch (error: any) {
      console.error("Worker Error:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  receiver.app.listen(PORT, () => {
    console.log(`GCP AIBot Service running on port ${PORT}`);
  });
}

// Start everything
startApp().catch(err => {
  console.error("Failed to start app:", err);
  process.exit(1);
});

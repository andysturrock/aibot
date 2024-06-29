import { Block, HomeView, KnownBlock } from "@slack/bolt";
import { BotsInfoArguments, ChatDeleteArguments, LogLevel, ReactionsAddArguments, ReactionsRemoveArguments, ViewsPublishArguments, WebClient } from "@slack/web-api";
import axios from 'axios';
import util from 'util';
import { getSecretValue } from './awsAPI';

async function createClient() {
  const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');

  return new WebClient(slackBotToken, {
    logLevel: LogLevel.INFO
  });
}

export async function getBotId() {
  const client = await createClient();
  const result = await client.auth.test();
  return result.bot_id;
}

/**
 * Get a bot's user id
 * @param botId 
 * @returns user id if the bot has one, else undefined
 */
export async function getBotUserId(botId: string, teamId: string) {
  const client = await createClient();
  const botsInfoArguments: BotsInfoArguments = {
    bot: botId,
    team_id: teamId
  };
  const result = await client.bots.info(botsInfoArguments);
  return result.bot?.user_id;
}

export async function publishHomeView(user: string, blocks: (KnownBlock | Block)[]) {
  const client = await createClient();
  const homeView: HomeView = {
    type: "home",
    blocks
  };
  const viewsPublishArguments: ViewsPublishArguments  = {
    user_id: user,
    view: homeView
  };
  await client.views.publish(viewsPublishArguments);
}

export async function postMessage(channelId: string, text:string, blocks: (KnownBlock | Block)[], thread_ts?: string) {
  const client = await createClient();
  await client.chat.postMessage({
    channel: channelId,
    text,
    blocks,
    thread_ts
  });
}

export async function postEphemeralMessage(channelId: string,
  userId: string,
  text:string,
  blocks: (KnownBlock | Block)[],
  threadTs?: string
) {
  const client = await createClient();
  const result = await client.chat.postEphemeral({
    user: userId,
    channel: channelId,
    text,
    blocks,
    thread_ts: threadTs
  });
  return result.message_ts;
}

export async function postEphmeralErrorMessage(channelId: string, userId:string, text: string) {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text
      }
    }
  ];
  await postEphemeralMessage(channelId, userId, text, blocks);
}

export async function deleteMessage(channelId: string, ts: string) {
  const client = await createClient();
  const chatDeleteArguments: ChatDeleteArguments = {
    channel: channelId,
    ts
  };
  const result = await client.chat.delete(chatDeleteArguments);
  console.log(`delete result: ${util.inspect(result, false, null)}`);
}

export async function addReaction(channelId: string, timestamp: string, name: string) {
  const client = await createClient();
  const reactionsAddArguments: ReactionsAddArguments = {
    channel: channelId,
    timestamp,
    name
  };
  await client.reactions.add(reactionsAddArguments);
}

export async function removeReaction(channelId: string, timestamp: string, name: string) {
  const client = await createClient();
  const reactionsRemoveArguments: ReactionsRemoveArguments = {
    channel: channelId,
    timestamp,
    name
  };
  await client.reactions.remove(reactionsRemoveArguments);
}

export async function postToResponseUrl(responseUrl: string, responseType: "ephemeral" | "in_channel", text: string, blocks: KnownBlock[]) {
  const messageBody = {
    response_type: responseType,
    text,
    blocks
  };
  const result = await axios.post(responseUrl, messageBody);
  return result;
}

export async function postErrorMessageToResponseUrl(responseUrl: string, text: string) {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text
      }
    }
  ];
  await postToResponseUrl(responseUrl, "ephemeral", text, blocks);
}

export type PromptCommandPayload = {
  response_url?: string,
  channel?: string,
  user_id: string,
  text: string,
  command?: string,
  event_ts?: string,
  thread_ts?: string,
  bot_id: string,
  team_id: string
};

export type Action = {
  action_id: string,
  value: string
};


import {WebClient, LogLevel, ViewsPublishArguments} from "@slack/web-api";
import {getSecretValue} from './awsAPI';
import {Block, HomeView, KnownBlock} from "@slack/bolt";
import axios from 'axios';

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

export async function postEphemeralMessage(channelId: string, userId: string, text:string, blocks: (KnownBlock | Block)[]) {
  const client = await createClient();
  await client.chat.postEphemeral({
    user: userId,
    channel: channelId,
    text,
    blocks
  });  
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
  event_ts?: string
};

export type Action = {
  action_id: string,
  value: string
};


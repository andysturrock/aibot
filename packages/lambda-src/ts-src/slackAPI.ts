import { Block, GenericMessageEvent, HomeView, KnownBlock } from "@slack/bolt";
import {
  BotsInfoArguments,
  ChatDeleteArguments,
  ChatGetPermalinkArguments,
  ConversationsHistoryArguments,
  ConversationsInfoArguments,
  ConversationsListArguments,
  ConversationsRepliesArguments,
  LogLevel,
  ReactionsAddArguments,
  ReactionsRemoveArguments,
  UsersInfoArguments,
  ViewsPublishArguments,
  WebClient
} from "@slack/web-api";
import axios from 'axios';
import { getSecretValue } from './awsAPI';
import { getAccessToken } from "./tokensTable";

async function createClient() {
  const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');

  return new WebClient(slackBotToken, {
    logLevel: LogLevel.INFO
  });
}

async function createUserClient(slackId: string) {
  const slackUserToken = await getAccessToken(slackId);
  
  if(!slackUserToken) {
    throw new Error("Cannot get Slack user token from table.");
  }

  return new WebClient(slackUserToken, {
    logLevel: LogLevel.INFO
  });
}

function createUserClientFromToken(slackUserToken: string) {
  return new WebClient(slackUserToken, {
    logLevel: LogLevel.INFO
  });
}

export async function getBotId() {
  const client = await createClient();
  const result = await client.auth.test();
  return {
    bot_id: result.bot_id,
    bot_user_id: result.user_id
  };
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
export async function postTextMessage(channelId: string, text:string, thread_ts?: string) {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text
      }
    }
  ];
  await postMessage(channelId, text, blocks, thread_ts);
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

export async function postEphmeralErrorMessage(channelId: string, userId:string, text: string, threadTs?: string) {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text
      }
    }
  ];
  await postEphemeralMessage(channelId, userId, text, blocks, threadTs);
}

export async function deleteMessage(channelId: string, ts: string) {
  const client = await createClient();
  const chatDeleteArguments: ChatDeleteArguments = {
    channel: channelId,
    ts
  };
  await client.chat.delete(chatDeleteArguments);
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

export type Message = {
  channel: string,
  user: string,
  text: string,
  date?: Date,
  ts: string,
  threadTs?: string
};

function tsToDate(ts: string) {
  const seconds = ts.split('.')[0];
  return ts ? new Date(Number.parseInt(seconds) * 1000) : undefined;
}

export async function getThreadMessagesUsingToken(slackUserToken: string, channelId: string, threadTs: string, oldest?: string, latest?: string) {
  const client = createUserClientFromToken(slackUserToken);
  return await _getThreadMessages(client, channelId, threadTs, oldest, latest);
}

export async function getThreadMessages(slackId: string, channelId: string, threadTs: string, oldest?: string, latest?: string) {
  const client = await createUserClient(slackId);
  return await _getThreadMessages(client, channelId, threadTs, oldest, latest);
}

async function _getThreadMessages(client: WebClient, channelId: string, threadTs: string, oldest?: string, latest?: string) {
  const conversationsRepliesArguments: ConversationsRepliesArguments = {
    channel: channelId,
    ts: threadTs,
    oldest,
    latest,
    inclusive: true
  };
  const replies = await client.conversations.replies(conversationsRepliesArguments);
  
  const messageReplies = replies.messages?.filter(message => (message.type == "message" && message.text && message.text.length > 0)) ?? [];
  const messages: Message[] = messageReplies.map(message => {
    const date = message.ts ? tsToDate(message.ts) : undefined;
    return {
      channel: channelId,
      user: message.user ?? "",
      text: message.text ?? "",
      date,
      ts: message.ts ?? "",
      threadTs: message.thread_ts
    };
  });
  return messages;
}

export async function getChannelMessagesUsingToken(slackUserToken: string, channelId: string, oldest?: string, latest?: string, includeThreads?: boolean) {
  const client = createUserClientFromToken(slackUserToken);
  return await _getChannelMessages(client, channelId, oldest,latest, includeThreads);
}

export async function getChannelMessages(slackId: string, channelId: string, oldest?: string, latest?: string, includeThreads = true) {
  const client = await createUserClient(slackId);
  return await _getChannelMessages(client, channelId, oldest, latest, includeThreads);
}

async function _getChannelMessages(client: WebClient, channelId: string, oldest?: string, latest?: string, includeThreads = true) {
  const conversationsHistoryArguments: ConversationsHistoryArguments = {
    channel: channelId,
    oldest,
    latest,
    inclusive: true
  };
  const history = await client.conversations.history(conversationsHistoryArguments);
  
  if(includeThreads) {
    // The thread includes the main message so don't need to get that separately.
    const messages: Message[] = [];
    for(const message of history.messages ?? []) {
      if(message.reply_count && message.reply_count > 0 && message.ts) {
        const threadMessages = await _getThreadMessages(client, channelId, message.ts);
        // Reverse the order of the thread messages because they are returned oldest first
        // whereas channel messages returned newest first.
        messages.push(...threadMessages.reverse());
      }
      else if(message.type == "message" && message.text && message.text.length > 0) {
        const date = message.ts ? tsToDate(message.ts) : undefined;
        messages.push({
          channel: channelId,
          user: message.user ?? "",
          text: message.text ?? "",
          date,
          ts: message.ts ?? ""
        });
      }
    }
    return messages;
  }
  else {
    // Just return the main messages.
    const messageReplies = history.messages?.filter(message => message.type == "message") ?? [];
    const messages: Message[] = messageReplies.map(message => {
      return {
        channel: channelId,
        user: message.user ?? "",
        text: message.text ?? "",
        ts: message.ts ?? ""
      };
    });
    return messages;
  }
}

export async function getUserRealName(userId: string) {
  const client = await createClient();
  const usersInfoArguments: UsersInfoArguments = {
    user: userId
  };
  const usersInfoResponse = await client.users.info(usersInfoArguments);
  return usersInfoResponse.user?.real_name;
}

export async function getPublicChannelsUsingToken(slackUserToken: string, team_id: string) {
  const client = createUserClientFromToken(slackUserToken);
  return await _getPublicChannels(client, team_id);
}

export async function getPublicChannels(team_id: string) {
  const client = await createClient();
  return await _getPublicChannels(client, team_id);
}

async function _getPublicChannels(client: WebClient, team_id: string) {
  const conversationsListArguments: ConversationsListArguments = {
    types: "public_channel",
    team_id
  };
  const conversationsListResponse = await client.conversations.list(conversationsListArguments);
  return conversationsListResponse.channels;
}

export async function getTeams() {
  const client = await createClient();
  const authTeamsListResponse = await client.auth.teams.list();
  return authTeamsListResponse.teams;
}

export async function getPermaLink(channelId: string, ts: string) {
  const client = await createClient();
  const chatGetPermalinkArguments: ChatGetPermalinkArguments = {
    channel: channelId,
    message_ts: ts
  };
  const chatGetPermalinkResponse = await client.chat.getPermalink(chatGetPermalinkArguments);
  return chatGetPermalinkResponse.permalink;
}

export async function getChannelName(channelId: string) {
  const client = await createClient();
  const conversationsInfoArguments: ConversationsInfoArguments = {
    channel: channelId,
  };
  const conversationsInfoResponse = await client.conversations.info(conversationsInfoArguments);
  return conversationsInfoResponse.channel?.name;
}

export async function getMessageTextUsingToken(slackUserToken:string, channelId: string, ts: string) {
  const client = createUserClientFromToken(slackUserToken);
  const conversationsHistoryArguments: ConversationsHistoryArguments = {
    channel: channelId,
    latest: ts,
    inclusive: true,
    limit: 1
  };
  const conversationsHistoryResponse = await client.conversations.history(conversationsHistoryArguments);
  return conversationsHistoryResponse.messages?.[0].text;
}

export type PromptCommandPayload = {
  channel?: string,
  user_id: string,
  text: string,
  command?: string,
  event_ts?: string,
  thread_ts?: string,
  bot_id: string,
  bot_user_id: string,
  team_id: string,
} & GenericMessageEvent;

// The File type is not exported from node_modules/@slack/bolt/dist/types/events/message-events.d.ts
// So use some Typescript type trickery here to extract it and export it.
type ArrayElement<ArrayType extends readonly unknown[]> = 
  ArrayType extends readonly (infer ElementType)[] ? ElementType : never;
type FilesArray = NonNullable<GenericMessageEvent['files']>;
export type File = ArrayElement<FilesArray>;

// Channel is exported from @slack/web-api/dist/response/ConversationsListResponse
// But that's a bit weird for other files to import, so just re-export it here
export type { Channel } from '@slack/web-api/dist/response/ConversationsListResponse';

export type Action = {
  action_id: string,
  value: string
};


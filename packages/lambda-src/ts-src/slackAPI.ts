import { Block, HomeView, KnownBlock } from "@slack/bolt";
import { BotsInfoArguments, ChatDeleteArguments, ConversationsHistoryArguments, ConversationsRepliesArguments, LogLevel, ReactionsAddArguments, ReactionsRemoveArguments, ViewsPublishArguments, WebClient } from "@slack/web-api";
import axios from 'axios';
import { getSecretValue } from './awsAPI';

async function createClient() {
  const slackBotToken = await getSecretValue('AIBot', 'slackBotToken');

  return new WebClient(slackBotToken, {
    logLevel: LogLevel.INFO
  });
}

async function createUserClient() {
  const slackBotUserToken = await getSecretValue('AIBot', 'slackBotUserToken');

  return new WebClient(slackBotUserToken, {
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
  user: string,
  text: string,
  date?: Date
};

function tsToDate(ts: string) {
  const seconds = ts.split('.')[0];
  return ts ? new Date(Number.parseInt(seconds) * 1000) : undefined;
}

export async function getThreadMessages(channelId: string, threadTs: string) {
  // Note requires user token. See https://api.slack.com/methods/conversations.replies.
  const client = await createUserClient();
  const conversationsRepliesArguments: ConversationsRepliesArguments = {
    channel: channelId,
    ts: threadTs
  };
  const replies = await client.conversations.replies(conversationsRepliesArguments);
  
  const messageReplies = replies.messages?.filter(message => (message.type == "message" && message.text && message.text.length > 0)) ?? [];
  const messages: Message[] = messageReplies.map(message => {
    const date = message.ts ? tsToDate(message.ts) : undefined;
    return {
      user: message.user ?? "",
      text: message.text ?? "",
      date
    };
  });
  return messages;
}

export async function getChannelMessages(channelId: string, oldest? : string | undefined, includeThreads = true) {
  const client = await createClient();
  const conversationsHistoryArguments: ConversationsHistoryArguments = {
    channel: channelId,
    oldest
  };
  const history = await client.conversations.history(conversationsHistoryArguments);
  
  if(includeThreads) {
    // The thread includes the main message so don't need to get that separately.
    const messages: Message[] = [];
    for(const message of history.messages ?? []) {
      if(message.reply_count && message.reply_count > 0 && message.ts) {
        const threadMessages = await getThreadMessages(channelId, message.ts);
        // Reverse the order of the thread messages because they are returned oldest first
        // whereas channel messages returned newest first.
        messages.push(...threadMessages.reverse());
      }
      else if(message.type == "message" && message.text && message.text.length > 0) {
        const date = message.ts ? tsToDate(message.ts) : undefined;
        messages.push({
          user: message.user ?? "",
          text: message.text ?? "",
          date
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
        user: message.user ?? "",
        text: message.text ?? "",
        ts: message.ts ?? ""
      };
    });
    return messages;
  }
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
  bot_user_id: string,
  team_id: string
};

export type Action = {
  action_id: string,
  value: string
};


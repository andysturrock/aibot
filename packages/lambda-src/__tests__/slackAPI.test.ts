import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as slackAPI from '../ts-src/slackAPI';
import axios from 'axios';
import { WebClient } from '@slack/web-api';

vi.mock('@slack/web-api', () => {
  const mockChat = {
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
    postEphemeral: vi.fn().mockResolvedValue({ ok: true, message_ts: '123' }),
    delete: vi.fn().mockResolvedValue({ ok: true })
  };
  const mockAuth = {
    test: vi.fn().mockResolvedValue({ ok: true, bot_id: 'B1', user_id: 'U1' }),
    teams: {
      list: vi.fn().mockResolvedValue({ ok: true, teams: [] })
    }
  };
  const mockReactions = {
    add: vi.fn().mockResolvedValue({ ok: true }),
    remove: vi.fn().mockResolvedValue({ ok: true })
  };
  const mockConversations = {
    replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    list: vi.fn().mockResolvedValue({ ok: true, channels: [] }),
    info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } })
  };
  const mockViews = {
    publish: vi.fn().mockResolvedValue({ ok: true })
  };
  const mockUsers = {
    info: vi.fn().mockResolvedValue({ ok: true, user: { real_name: 'John Doe' } })
  };
  const mockBots = {
    info: vi.fn().mockResolvedValue({ ok: true, bot: { user_id: 'UB1' } })
  };

  return {
    WebClient: vi.fn().mockImplementation(function () {
      return {
        chat: mockChat,
        auth: mockAuth,
        reactions: mockReactions,
        conversations: mockConversations,
        views: mockViews,
        users: mockUsers,
        bots: mockBots,
      };
    }),
    LogLevel: { INFO: 'info' }
  };
});

vi.mock('axios');
vi.mock('../ts-src/awsAPI', () => ({
  getSecretValue: vi.fn().mockResolvedValue('test-token')
}));
vi.mock('../ts-src/tokensTable', () => ({
  getAccessToken: vi.fn().mockResolvedValue('user-token')
}));

describe('slackAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should get bot ID', async () => {
    const result = await slackAPI.getBotId();
    expect(result.bot_id).toBe('B1');
    expect(result.bot_user_id).toBe('U1');
  });

  it('should get bot user ID', async () => {
    const userId = await slackAPI.getBotUserId('B1', 'T1');
    expect(userId).toBe('UB1');
  });

  it('should post message', async () => {
    await slackAPI.postMessage('C1', 'text', []);
    const client = new WebClient('test');
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C1',
      text: 'text'
    }));
  });

  it('should add and remove reaction', async () => {
    await slackAPI.addReaction('C1', '123', 'eyes');
    await slackAPI.removeReaction('C1', '123', 'eyes');
    const client = new WebClient('test');
    expect(client.reactions.add).toHaveBeenCalled();
    expect(client.reactions.remove).toHaveBeenCalled();
  });

  it('should post to response URL using axios', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: 'ok' });
    await slackAPI.postToResponseUrl('http://test.com', 'ephemeral', 'text', []);
    expect(postSpy).toHaveBeenCalledWith('http://test.com', expect.objectContaining({
      text: 'text'
    }));
  });

  it('should get thread messages', async () => {
    const mockMessages = [{ type: 'message', text: 'hi', ts: '1.2' }];
    const client = new WebClient('test');
    const repliesSpy = vi.spyOn(client.conversations, 'replies').mockResolvedValue({ ok: true, messages: mockMessages } as never);

    const messages = await slackAPI.getThreadMessages('U1', 'C1', '1.1');
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('hi');
    expect(repliesSpy).toHaveBeenCalled();
  });
});

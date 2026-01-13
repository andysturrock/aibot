import { vi, describe, it, expect, beforeEach } from 'vitest';
import { handleEventsEndpoint } from '../ts-src/handleEventsEndpoint';
import { handleInteractiveEndpoint } from '../ts-src/handleInteractiveEndpoint';
import { handleSlackAuthRedirect } from '../ts-src/handleSlackAuthRedirect';
import { APIGatewayProxyEvent } from 'aws-lambda';
import * as awsAPI from '../ts-src/awsAPI';
import * as slackAPI from '../ts-src/slackAPI';
import axios from 'axios';

vi.mock('../ts-src/awsAPI');
vi.mock('../ts-src/slackAPI');
vi.mock('../ts-src/verifySlackRequest');
vi.mock('../ts-src/tokensTable');
vi.mock('axios');

describe('endpointHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(awsAPI.getSecretValue).mockResolvedValue('secret');
  });

  describe('handleEventsEndpoint', () => {
    it('should handle URL verification', async () => {
      const event = {
        body: JSON.stringify({ type: 'url_verification', challenge: 'test-challenge' }),
        headers: {}
      } as unknown as APIGatewayProxyEvent;

      const result = await handleEventsEndpoint(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body) as { challenge: string };
      expect(body.challenge).toBe('test-challenge');
    });

    it('should handle app mentions and invoke lambda', async () => {
      vi.mocked(slackAPI.getBotId).mockResolvedValue({ bot_id: 'B1', bot_user_id: 'U1' });
      vi.mocked(awsAPI.getSecretValue).mockImplementation((_s, key) => Promise.resolve(key === 'ignoreMessagesFromTheseIds' ? '' : 'secret'));

      const event = {
        body: JSON.stringify({
          event: {
            type: 'app_mention',
            user: 'U2',
            text: 'hi',
            channel: 'C1',
            event_ts: '123'
          },
          team_id: 'T1'
        }),
        headers: {}
      } as unknown as APIGatewayProxyEvent;

      const result = await handleEventsEndpoint(event);
      expect(result.statusCode).toBe(200);
      expect(awsAPI.invokeLambda).toHaveBeenCalled();
    });
  });

  describe('handleInteractiveEndpoint', () => {
    it('should handle block actions', async () => {
      const event = {
        body: 'payload=' + JSON.stringify({
          type: 'block_actions',
          actions: [{ action_id: 'authButton' }],
          user: { id: 'U1' }
        }),
        headers: {}
      } as unknown as APIGatewayProxyEvent;

      const result = await handleInteractiveEndpoint(event);
      expect(result.statusCode).toBe(200);
      expect(slackAPI.publishHomeView).toHaveBeenCalled();
    });
  });

  describe('handleSlackAuthRedirect', () => {
    it('should handle successful OAuth redirect', async () => {
      vi.spyOn(axios, 'post').mockResolvedValue({
        data: {
          ok: true,
          authed_user: { id: 'U1', access_token: 'token' },
          team: { name: 'T1' }
        }
      });

      const event = {
        queryStringParameters: { code: '123' }
      } as unknown as APIGatewayProxyEvent;

      const result = await handleSlackAuthRedirect(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('Successfully installed');
    });
  });
});

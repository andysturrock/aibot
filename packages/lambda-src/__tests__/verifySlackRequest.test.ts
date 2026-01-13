import { vi, describe, it, expect } from 'vitest';
import { verifySlackRequest } from '../ts-src/verifySlackRequest';
import { verifySlackRequest as _verifySlackRequest } from '@slack/bolt';
import { APIGatewayProxyEventHeaders } from 'aws-lambda';

vi.mock('@slack/bolt', () => ({
  verifySlackRequest: vi.fn(),
}));

describe('verifySlackRequest', () => {
  const secret = 'test-secret';

  it('should verify a valid request', () => {
    const headers = {
      'X-Slack-Signature': 'v0=signature',
      'X-Slack-Request-Timestamp': '123456789'
    };
    const body = 'body';

    verifySlackRequest(secret, headers, body);

    expect(_verifySlackRequest).toHaveBeenCalledWith({
      signingSecret: secret,
      body: body,
      headers: {
        'x-slack-signature': 'v0=signature',
        'x-slack-request-timestamp': 123456789
      }
    });
  });

  it('should throw if X-Slack-Signature is missing', () => {
    const headers = {
      'X-Slack-Request-Timestamp': '123456789'
    };
    expect(() => { verifySlackRequest(secret, headers, 'body'); }).toThrow('Missing X-Slack-Signature header');
  });

  it('should throw if X-Slack-Request-Timestamp is missing', () => {
    const headers = {
      'X-Slack-Signature': 'v0=signature'
    };
    expect(() => { verifySlackRequest(secret, headers, 'body'); }).toThrow('Missing X-Slack-Request-Timestamp header');
  });

  it('should handle array headers', () => {
    const headers = {
      'X-Slack-Signature': ['v0=signature'],
      'X-Slack-Request-Timestamp': ['123456789']
    };
    // Cast to APIGatewayProxyEventHeaders to simulate potentially malformed headers from AWS
    verifySlackRequest(secret, headers as unknown as APIGatewayProxyEventHeaders, 'body');
    expect(_verifySlackRequest).toHaveBeenCalled();
  });
});

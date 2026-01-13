import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as tokensTable from '../ts-src/tokensTable';
import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

vi.mock('@aws-sdk/client-dynamodb', () => {
  const mockSend = vi.fn();
  return {
    DynamoDBClient: vi.fn().mockImplementation(function () {
      return { send: mockSend };
    }),
    QueryCommand: vi.fn().mockImplementation(function (params: unknown) { return params; }),
    PutItemCommand: vi.fn().mockImplementation(function (params: unknown) { return params; }),
    DeleteItemCommand: vi.fn().mockImplementation(function (params: unknown) { return params; }),
  };
});

describe('tokensTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should get access token', async () => {
    const client = new DynamoDBClient({});
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({
      Items: [{ access_token: { S: 'test-token' } }]
    } as never);

    const token = await tokensTable.getAccessToken('U1');
    expect(token).toBe('test-token');
    expect(sendSpy).toHaveBeenCalled();
  });

  it('should return undefined if no token found', async () => {
    const client = new DynamoDBClient({});
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ Items: [] } as never);

    const token = await tokensTable.getAccessToken('U1');
    expect(token).toBeUndefined();
    expect(sendSpy).toHaveBeenCalled();
  });

  it('should delete access token', async () => {
    await tokensTable.deleteAccessToken('U1');
    expect(DeleteItemCommand).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'AIBot_Tokens',
      Key: { slack_id: { S: 'U1' } }
    }));
  });

  it('should put access token', async () => {
    await tokensTable.putAccessToken('U1', 'new-token');
    expect(PutItemCommand).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'AIBot_Tokens',
      Item: {
        slack_id: { S: 'U1' },
        access_token: { S: 'new-token' }
      }
    }));
  });
});

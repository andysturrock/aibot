import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getHistory, putHistory, deleteHistory } from '../ts-src/historyTable';
import { DynamoDBClient, QueryCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

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

describe('historyTable', () => {
  const channelId = 'C123';
  const threadTs = '1234.567';
  const agentName = 'TestAgent';
  const mockDdbClient = new DynamoDBClient({});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getHistory', () => {
    it('should return history when items are found', async () => {
      const mockHistory = [{ role: 'user', parts: [{ text: 'hello' }] }];
      // Use a localized type representing the mocked send method for type safety
      type MockedSend = { mockResolvedValueOnce: (val: unknown) => void };
      (mockDdbClient.send as unknown as MockedSend).mockResolvedValueOnce({
        Items: [
          {
            history: { S: JSON.stringify(mockHistory) }
          }
        ]
      });

      const result = await getHistory(channelId, threadTs, agentName);

      expect(result).toEqual(mockHistory);
      expect(QueryCommand).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'AIBot_History',
        KeyConditionExpression: 'id = :id',
        ExpressionAttributeValues: {
          ':id': { S: `${channelId}_${threadTs}_${agentName}` }
        }
      }));
    });

    it('should return undefined when no items are found', async () => {
      // Use a localized type representing the mocked send method for type safety
      type MockedSend = { mockResolvedValueOnce: (val: unknown) => void };
      (mockDdbClient.send as unknown as MockedSend).mockResolvedValueOnce({ Items: [] });

      const result = await getHistory(channelId, threadTs, agentName);

      expect(result).toBeUndefined();
    });
  });

  describe('putHistory', () => {
    it('should send PutItemCommand with correct params', async () => {
      const history = [{ role: 'user', parts: [{ text: 'hello' }] }];

      await putHistory(channelId, threadTs, history, agentName);

      expect(PutItemCommand).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'AIBot_History',
        Item: expect.objectContaining({
          id: { S: `${channelId}_${threadTs}_${agentName}` },
          history: { S: JSON.stringify(history) },
          expiry: expect.objectContaining({ N: expect.any(String) as unknown as string }) as unknown as Record<string, string>
        }) as unknown as Record<string, unknown>
      }));
    });
  });

  describe('deleteHistory', () => {
    it('should send DeleteItemCommand with correct params', async () => {
      await deleteHistory(channelId, threadTs, agentName);

      expect(DeleteItemCommand).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'AIBot_History',
        Key: {
          id: { S: `${channelId}_${threadTs}_${agentName}` }
        }
      }));
    });
  });
});

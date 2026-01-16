import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getHistory, putHistory, deleteHistory } from '../ts-src/gcpHistoryTable';

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn(() => ({
  get: mockGet,
  set: mockSet,
  delete: mockDelete
}));
const mockCollection = vi.fn(() => ({
  doc: mockDoc
}));

vi.mock('@google-cloud/firestore', () => {
  return {
    Firestore: vi.fn().mockImplementation(function () {
      return {
        collection: mockCollection
      };
    })
  };
});

describe('gcpHistoryTable', () => {
  const channelId = 'C123';
  const threadTs = '1234.567';
  const agentName = 'TestAgent';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getHistory', () => {
    it('should return history when items are found', async () => {
      const mockHistory = [{ role: 'user', parts: [{ text: 'hello' }] }];
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({ history: JSON.stringify(mockHistory) })
      });

      const result = await getHistory(channelId, threadTs, agentName);

      expect(result).toEqual(mockHistory);
      expect(mockCollection).toHaveBeenCalledWith('AIBot_History');
      expect(mockDoc).toHaveBeenCalledWith(`${channelId}_${threadTs}_${agentName}`);
    });

    it('should return undefined when no items are found', async () => {
      mockGet.mockResolvedValue({ exists: false });

      const result = await getHistory(channelId, threadTs, agentName);

      expect(result).toBeUndefined();
    });
  });

  describe('putHistory', () => {
    it('should set doc with correct params', async () => {
      const history = [{ role: 'user', parts: [{ text: 'hello' }] }];

      await putHistory(channelId, threadTs, history, agentName);

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        history: JSON.stringify(history),
        channel_id: channelId,
        thread_ts: threadTs,
        agent_name: agentName
      }));
    });
  });

  describe('deleteHistory', () => {
    it('should delete doc with correct params', async () => {
      await deleteHistory(channelId, threadTs, agentName);

      expect(mockDelete).toHaveBeenCalled();
      expect(mockDoc).toHaveBeenCalledWith(`${channelId}_${threadTs}_${agentName}`);
    });
  });
});

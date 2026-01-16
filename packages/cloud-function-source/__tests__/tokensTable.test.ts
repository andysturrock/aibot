import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as tokensTable from '../ts-src/gcpTokensTable';

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

describe('gcpTokensTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should get access token', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ access_token: 'test-token' })
    });

    const token = await tokensTable.getAccessToken('U1');
    expect(token).toBe('test-token');
    expect(mockCollection).toHaveBeenCalledWith('AIBot_Tokens');
    expect(mockDoc).toHaveBeenCalledWith('U1');
  });

  it('should return undefined if no token found', async () => {
    mockGet.mockResolvedValue({
      exists: false
    });

    const token = await tokensTable.getAccessToken('U1');
    expect(token).toBeUndefined();
  });

  it('should delete access token', async () => {
    await tokensTable.deleteAccessToken('U1');
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDoc).toHaveBeenCalledWith('U1');
  });

  it('should put access token', async () => {
    await tokensTable.putAccessToken('U1', 'new-token');
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      access_token: 'new-token',
      slack_id: 'U1'
    }));
  });
});

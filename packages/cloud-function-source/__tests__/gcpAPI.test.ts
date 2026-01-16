import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as gcpAPI from '../ts-src/gcpAPI';

const mockAccessSecretVersion = vi.fn();
vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(function () {
    return {
      accessSecretVersion: mockAccessSecretVersion
    };
  })
}));

const mockTopicPublish = vi.fn();
const mockTopic = vi.fn(() => ({
  publishMessage: mockTopicPublish
}));
vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn().mockImplementation(function () {
    return {
      topic: mockTopic
    };
  })
}));

describe('gcpAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.testKey;
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    process.env.GCP_PROJECT = 'test-project';
  });

  describe('getSecretValue', () => {
    it('should return value from process.env if present', async () => {
      process.env.testKey = 'env-value';
      const result = await gcpAPI.getSecretValue('AIBot', 'testKey');
      expect(result).toBe('env-value');
    });

    it('should return value from Secret Manager if not in env', async () => {
      mockAccessSecretVersion.mockResolvedValue([{
        payload: { data: Buffer.from(JSON.stringify({ testKey: 'sm-value' })) }
      }]);

      const result = await gcpAPI.getSecretValue('AIBot', 'testKey');
      expect(result).toBe('sm-value');
    });

    it('should throw error if secret key not found', async () => {
      mockAccessSecretVersion.mockResolvedValue([{
        payload: { data: Buffer.from(JSON.stringify({ otherKey: 'value' })) }
      }]);

      await expect(gcpAPI.getSecretValue('AIBot', 'testKey')).rejects.toThrow('Failed to parse secret AIBot as JSON: Error: Secret key testKey not found in AIBot');
    });
  });

  describe('publishToTopic', () => {
    it('should publish message to topic', async () => {
      mockTopicPublish.mockResolvedValue('msg-id');
      await gcpAPI.publishToTopic('test-topic', 'test-data');
      expect(mockTopic).toHaveBeenCalledWith('test-topic');
      expect(mockTopicPublish).toHaveBeenCalledWith({ data: Buffer.from('test-data') });
    });
  });
});

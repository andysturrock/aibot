import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as awsAPI from '../ts-src/awsAPI';
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { LambdaClient } from "@aws-sdk/client-lambda";

vi.mock("@aws-sdk/client-secrets-manager", () => {
  const mockSend = vi.fn();
  return {
    SecretsManagerClient: vi.fn().mockImplementation(function () {
      return { send: mockSend };
    }),
    GetSecretValueCommand: vi.fn().mockImplementation(function (input: unknown) { return input; })
  };
});

vi.mock("@aws-sdk/client-lambda", () => {
  const mockSend = vi.fn();
  return {
    LambdaClient: vi.fn().mockImplementation(function () {
      return { send: mockSend };
    }),
    InvokeCommand: vi.fn().mockImplementation(function (input: unknown) { return input; }),
    InvocationType: { Event: 'Event' }
  };
});

describe('awsAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.testKey;
  });

  describe('getSecretValue', () => {
    it('should return value from process.env if present', async () => {
      process.env.testKey = 'env-value';
      const result = await awsAPI.getSecretValue('secret', 'testKey');
      expect(result).toBe('env-value');
    });

    it('should return value from Secrets Manager if not in env', async () => {
      const client = new SecretsManagerClient({});
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({
        SecretString: JSON.stringify({ testKey: 'sm-value' })
      } as never);

      const result = await awsAPI.getSecretValue('secret', 'testKey');
      expect(result).toBe('sm-value');
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should throw error if secret key not found', async () => {
      const client = new SecretsManagerClient({});
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({
        SecretString: JSON.stringify({ otherKey: 'value' })
      } as never);

      await expect(awsAPI.getSecretValue('secret', 'testKey')).rejects.toThrow('Secret key testKey not found');
      expect(sendSpy).toHaveBeenCalled();
    });
  });

  describe('invokeLambda', () => {
    it('should invoke lambda successfully', async () => {
      const client = new LambdaClient({});
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ StatusCode: 202 } as never);

      await awsAPI.invokeLambda('my-func', '{}');
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should throw error on failure', async () => {
      const client = new LambdaClient({});
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ StatusCode: 500, FunctionError: 'some error' } as never);

      await expect(awsAPI.invokeLambda('my-func', '{}')).rejects.toThrow('some error');
      expect(sendSpy).toHaveBeenCalled();
    });
  });
});

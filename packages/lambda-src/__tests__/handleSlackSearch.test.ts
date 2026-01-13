import { vi, describe, it, expect, beforeEach } from 'vitest';
import { handleSlackSearch } from '../ts-src/handleSlackSearch';
import { ModelFunctionCallArgs } from '../ts-src/aiService';
import { Gemini } from '@google/adk';
import { PredictionServiceClient } from '@google-cloud/aiplatform';
import { BigQuery } from '@google-cloud/bigquery';
import { GenerateContentParameters, GoogleGenAI } from '@google/genai';
import * as awsAPI from '../ts-src/awsAPI';
import * as slackAPI from '../ts-src/slackAPI';

// Mock all internal and external dependencies
vi.mock('@google-cloud/aiplatform', () => ({
  helpers: {
    toValue: vi.fn((val: unknown) => val)
  },
  PredictionServiceClient: vi.fn().mockImplementation(function () {
    return {
      predict: vi.fn().mockResolvedValue([{
        predictions: [{
          structValue: {
            fields: {
              embeddings: {
                structValue: {
                  fields: {
                    values: {
                      listValue: {
                        values: [{ numberValue: 0.1 }, { numberValue: 0.2 }]
                      }
                    }
                  }
                }
              }
            }
          }
        }]
      }])
    };
  })
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: vi.fn().mockImplementation(function () {
    return {
      createQueryJob: vi.fn().mockResolvedValue([{
        getQueryResults: vi.fn().mockResolvedValue([[{ channel: 'C1', ts: 123, distance: 0.1 }]])
      }])
    };
  })
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [{ content: { parts: [{ text: 'Response' }] } }]
        })
      }
    };
  })
}));

vi.mock('../ts-src/awsAPI', () => ({
  getSecretValue: vi.fn().mockResolvedValue('mock-value')
}));

vi.mock('../ts-src/slackAPI', () => ({
  getChannelName: vi.fn().mockResolvedValue('Channel Name'),
  getPermaLink: vi.fn().mockResolvedValue('http://slack.com/link'),
  getThreadMessagesUsingToken: vi.fn().mockResolvedValue([{ channel: 'C1', user: 'U1', text: 'message', ts: 123 }])
}));

describe('handleSlackSearch', () => {
  let mockGemini: Gemini;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGemini = {
      apiClient: new GoogleGenAI({ apiKey: 'key' })
    } as unknown as Gemini;
  });

  it('should orchestrate slack search correctly', async () => {
    const modelFunctionCallArgs: ModelFunctionCallArgs = {
      prompt: 'What is happening?',
      channelId: 'C1',
      parentThreadTs: '123'
    };
    const generateContentRequest = {
      model: 'gemini-1.5-flash',
      contents: [{ role: 'user', parts: [] }]
    };

    const result = await handleSlackSearch(mockGemini, modelFunctionCallArgs, generateContentRequest);

    expect(result).toBeDefined();
    expect(awsAPI.getSecretValue).toHaveBeenCalledWith('AIBot', 'gcpProjectId');
    expect(PredictionServiceClient).toHaveBeenCalled();
    expect(BigQuery).toHaveBeenCalled();
    expect(slackAPI.getThreadMessagesUsingToken).toHaveBeenCalled();
    expect(slackAPI.getChannelName).toHaveBeenCalledWith('C1');
    expect(slackAPI.getPermaLink).toHaveBeenCalledWith('C1', 123);
  });

  it('should throw error if prompt is missing', async () => {
    // Cast to unknown then to specific type to bypass strict check for error case simulation
    const modelFunctionCallArgs = {} as unknown as ModelFunctionCallArgs;
    const generateContentRequest = {} as unknown as GenerateContentParameters;

    await expect(handleSlackSearch(mockGemini, modelFunctionCallArgs, generateContentRequest))
      .rejects.toThrow('modelFunctionCallArgs missing prompt');
  });

  it('should throw error if model is missing in request', async () => {
    const modelFunctionCallArgs: ModelFunctionCallArgs = {
      prompt: 'query',
      channelId: 'C1',
      parentThreadTs: '123'
    };
    const generateContentRequest = { contents: [{ role: 'user', parts: [] }] } as unknown as GenerateContentParameters;

    await expect(handleSlackSearch(mockGemini, modelFunctionCallArgs, generateContentRequest))
      .rejects.toThrow('generateContentRequest missing model name for search');
  });
});

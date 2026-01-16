import { vi, describe, it, expect, beforeEach } from 'vitest';
import { handleSlackSearch } from '../ts-src/handleSlackSearch';
import { ModelFunctionCallArgs } from '../ts-src/aiService.js';
import { Gemini } from '@google/adk';
import { GoogleGenAI } from '@google/genai';
import * as gcpAPI from '../ts-src/gcpAPI';

// Mock MCP Client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify([{ text: 'slack message' }]) }]
        }),
        close: vi.fn().mockResolvedValue(undefined)
      };
    })
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn()
}));

vi.mock('../ts-src/gcpAPI', () => ({
  getSecretValue: vi.fn().mockImplementation((_secret, key) => {
    if (key === 'mcpSlackSearchUrl') return Promise.resolve('http://mcp-server');
    if (key === 'slackUserToken') return Promise.resolve('test-token');
    return Promise.resolve('mock-value');
  })
}));

describe('handleSlackSearch', () => {
  let mockGemini: Gemini;
  const mockGenerateContent = vi.fn().mockResolvedValue({
    response: { text: () => 'Response' }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGemini = {
      apiClient: {
        models: {
          generateContent: mockGenerateContent
        }
      } as unknown as GoogleGenAI
    } as unknown as Gemini;
  });

  it('should orchestrate slack search via MCP correctly', async () => {
    const modelFunctionCallArgs: ModelFunctionCallArgs = {
      prompt: 'What is happening?',
      channelId: 'C1',
      parentThreadTs: '123'
    };
    const generateContentRequest = {
      contents: [{ role: 'user', parts: [] }]
    } as any;

    const result = await handleSlackSearch(mockGemini, modelFunctionCallArgs, generateContentRequest);

    expect(result).toBeDefined();
    expect(gcpAPI.getSecretValue).toHaveBeenCalledWith('AIBot', 'mcpSlackSearchUrl');
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('should throw error if prompt is missing', async () => {
    const modelFunctionCallArgs = {} as any;
    const generateContentRequest = {} as any;

    await expect(handleSlackSearch(mockGemini, modelFunctionCallArgs, generateContentRequest))
      .rejects.toThrow('modelFunctionCallArgs missing prompt');
  });
});

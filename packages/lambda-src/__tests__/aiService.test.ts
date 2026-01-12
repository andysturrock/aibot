import { beforeAll, describe, expect, it, jest } from '@jest/globals';

// Set environment variables for secrets to avoid real AWS calls
process.env.gcpProjectId = 'test-project';
process.env.gcpDataStoreIds = 'test-datastore';
process.env.gcpLocation = 'us-central1';
process.env.botName = 'TestBot';
process.env.slackSearchModel = 'gemini-1.5-flash';
process.env.googleSearchGroundedModel = 'gemini-1.5-flash';
process.env.customSearchGroundedModel = 'gemini-1.5-flash';
process.env.slackBotToken = 'test-slack-token';

// Mock lodash for ESM compatibility
jest.unstable_mockModule('lodash', () => ({
  default: { cloneDeep: (obj: any) => JSON.parse(JSON.stringify(obj)), merge: Object.assign },
  cloneDeep: (obj: any) => JSON.parse(JSON.stringify(obj)),
  merge: Object.assign,
}));

// Mock external library
jest.unstable_mockModule('@google-cloud/vertexai', () => {
  const mockGenerativeModel = {
    generateContent: jest.fn(() => Promise.resolve({
      response: {
        candidates: [{ content: { parts: [{ text: '{"answer": "Vertex AI search results", "attributions": []}' }] } }]
      }
    }))
  };
  return {
    VertexAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue(mockGenerativeModel)
    }))
  };
});

// Mock internal modules that perform network/external calls
jest.unstable_mockModule('../ts-src/slackAPI', () => ({
  postMessage: jest.fn(),
  postTextMessage: jest.fn(),
  postEphmeralErrorMessage: jest.fn(),
}));

jest.unstable_mockModule('../ts-src/handleSlackSearch', () => ({
  handleSlackSearch: jest.fn(() => Promise.resolve({
    candidates: [{ content: { role: 'model', parts: [{ text: '{"answer": "Slack results", "attributions": []}' }] } }]
  }))
}));

describe('aiService', () => {
  let aiService: any;

  beforeAll(async () => {
    try {
      // Dynamic import to allow mocks to be established
      aiService = await import('../ts-src/aiService');
    } catch (e) {
      console.error('Failed to import aiService:', e);
      throw e;
    }
  });

  it('should create a supervisor agent with sub-agents', async () => {
    const supervisor = await aiService.createSupervisorAgent();
    expect(supervisor.name).toBe('SupervisorAgent');
    expect(supervisor.subAgents).toBeDefined();
    expect(supervisor.subAgents.length).toBeGreaterThan(0);
  });

  describe('Utility Functions', () => {
    it('should parse JSON response and remove backticks', async () => {
      const input = '```json\n{"answer": "Hello world", "attributions": []}\n```';
      const result = await aiService.formatResponse(input);
      expect(result.answer).toBe('Hello world');
      expect(result.attributions).toEqual([]);
    });

    it('should handle broken JSON gracefully', async () => {
      const input = 'Not a JSON';
      const result = await aiService.formatResponse(input);
      expect(result.answer).toContain('Not a JSON');
    });

    it('should translate bold markdown', async () => {
      const input = '{"answer": "This is **bold**"}';
      const result = await aiService.formatResponse(input);
      expect(result.answer).toBe('This is *bold*');
    });
  });
});

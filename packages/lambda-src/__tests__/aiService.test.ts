import { vi, describe, it, expect } from 'vitest';
import * as aiService from '../ts-src/aiService';

// Set environment variables for secrets to avoid real AWS calls
process.env.gcpProjectId = 'test-project';
process.env.gcpDataStoreIds = 'test-datastore';
process.env.gcpLocation = 'us-central1';
process.env.botName = 'TestBot';
process.env.slackSearchModel = 'gemini-1.5-flash';
process.env.googleSearchGroundedModel = 'gemini-1.5-flash';
process.env.customSearchGroundedModel = 'gemini-1.5-flash';
process.env.slackBotToken = 'test-slack-token';

// Vitest handles hoisting vi.mock() calls and supports extensionless imports natively
vi.mock('@google-cloud/vertexai', () => ({
  VertexAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: vi.fn(() => Promise.resolve({
        response: {
          candidates: [{ content: { parts: [{ text: '{"answer": "Vertex AI search results", "attributions": []}' }] } }]
        }
      }))
    })
  }))
}));

vi.mock('../ts-src/slackAPI', () => ({
  postMessage: vi.fn(),
  postTextMessage: vi.fn(),
  postEphmeralErrorMessage: vi.fn(),
}));

vi.mock('../ts-src/awsAPI', () => ({
  getSecretValue: vi.fn((_secretName: string, key: string) => {
    const secrets: Record<string, string> = {
      gcpProjectId: 'test-project',
      gcpDataStoreIds: 'test-datastore',
      gcpLocation: 'us-central1',
      slackBotToken: 'test-slack-token',
      botName: 'TestBot',
      slackSearchModel: 'gemini-1.5-flash',
      googleSearchGroundedModel: 'gemini-1.5-flash',
      customSearchGroundedModel: 'gemini-1.5-flash'
    };
    return Promise.resolve(secrets[key] || '');
  }),
}));

vi.mock('../ts-src/handleSlackSearch', () => ({
  handleSlackSearch: vi.fn(() => Promise.resolve({
    candidates: [{ content: { role: 'model', parts: [{ text: '{"answer": "Slack results", "attributions": []}' }] } }]
  }))
}));

describe('aiService', () => {
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

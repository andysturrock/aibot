import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Runner } from '@google/adk';
import * as aiService from '../ts-src/aiService';
import * as slackAPI from '../ts-src/slackAPI';

// Set environment variables for secrets to avoid real GCP calls
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.botName = 'TestBot';

vi.mock('@google-cloud/vertexai', () => ({
  VertexAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: vi.fn(() => Promise.resolve({
          response: {
            candidates: [{ content: { parts: [{ text: '{"answer": "Vertex AI search results", "attributions": []}' }] } }]
          }
        }))
      })
    };
  })
}));

vi.mock('../ts-src/slackAPI', () => ({
  postMessage: vi.fn(),
  postTextMessage: vi.fn(),
  postEphmeralErrorMessage: vi.fn(),
}));

vi.mock('../ts-src/gcpAPI', () => ({
  getSecretValue: vi.fn((_secretName: string, key: string) => {
    const secrets: Record<string, string> = {
      gcpProjectId: 'test-project',
      gcpDataStoreIds: 'test-datastore',
      gcpLocation: 'us-central1',
      slackBotToken: 'test-slack-token',
      botName: 'TestBot',
      slackSearchModel: 'gemini-1.5-flash',
      googleSearchGroundedModel: 'gemini-1.5-flash',
      customSearchGroundedModel: 'gemini-1.5-flash',
      supervisorModel: 'gemini-1.5-flash'
    };
    return Promise.resolve(secrets[key] || '');
  }),
}));

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
vi.mock('@google/adk', () => {
  const mockRunner = {
    /* eslint-disable-next-line @typescript-eslint/require-await */
    runAsync: vi.fn().mockImplementation(async function* () {
      yield { content: { role: 'model', parts: [{ text: '{"answer": "mocked response"}' }] } };
    })
  };
  return {
    Runner: vi.fn().mockImplementation(function () { return mockRunner; }),
    createEvent: vi.fn((input) => input),
    InMemorySessionService: vi.fn().mockImplementation(function () {
      return {
        createSession: vi.fn().mockResolvedValue({}),
        appendEvent: vi.fn().mockImplementation((req: any) => Promise.resolve({ content: req.content })),
        getSession: vi.fn().mockResolvedValue({})
      };
    }),
    LlmAgent: vi.fn().mockImplementation(function (input: any) { return input; }),
    Gemini: vi.fn().mockImplementation(function (input: any) { return input; }),
    FunctionTool: vi.fn().mockImplementation(function (input: any) { return input; }),
    GOOGLE_SEARCH: 'google_search',
    BuiltInCodeExecutor: vi.fn().mockImplementation(function () { return {}; }),
    AgentTool: vi.fn().mockImplementation(function (input: any) { return input; }),
    LoggingPlugin: vi.fn().mockImplementation(function () { return {}; }),
  };
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

vi.mock('../ts-src/gcpHistoryTable', () => ({
  getHistory: vi.fn().mockResolvedValue([]),
  putHistory: vi.fn().mockResolvedValue({}),
}));

vi.mock('../ts-src/handleSlackSearch', () => ({
  handleSlackSearch: vi.fn(() => Promise.resolve({
    candidates: [{ content: { role: 'model', parts: [{ text: '{"answer": "Slack results", "attributions": []}' }] } }]
  }))
}));

describe('aiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a supervisor agent with sub-agents', async () => {
    const supervisor = await aiService.createSupervisorAgent();
    expect(supervisor.name).toBe('SupervisorAgent');
    expect(supervisor.tools).toBeDefined();
    expect(supervisor.tools.length).toBeGreaterThan(0);
  });

  describe('Utility Functions', () => {
    it('should parse JSON response and remove backticks', async () => {
      const input = '```json\n{"answer": "Hello world", "attributions": []}\n```';
      const result = await aiService.formatResponse(input, 'TestBot');
      expect(result.answer).toBe('Hello world');
      expect(result.attributions).toEqual([]);
    });

    it('should handle broken JSON gracefully', async () => {
      const input = 'Not a JSON';
      const result = await aiService.formatResponse(input, 'TestBot');
      expect(result.answer).toBe('Not a JSON');
    });

    it('should translate bold markdown', async () => {
      const input = '{"answer": "This is **bold**"}';
      const result = await aiService.formatResponse(input, 'TestBot');
      expect(result.answer).toBe('This is *bold*');
    });

    it('should handle missing answer field by using bot name', async () => {
      const result = await aiService.formatResponse('{}', 'TestBot');
      expect(result.answer).toBe('TestBot did not respond.');
    });
  });

  describe('generateResponseBlocks', () => {
    it('should split long text into multiple blocks', () => {
      const longText = 'a'.repeat(2100) + '\n' + 'b'.repeat(100);
      const response: aiService.Response = { answer: longText };
      const blocks = aiService.generateResponseBlocks(response);
      expect(blocks.length).toBeGreaterThan(1);
    });

    it('should add attribution blocks if present', () => {
      const response: aiService.Response = {
        answer: 'Hello',
        attributions: [{ title: 'Doc', uri: 'http://example.com' }]
      };
      const blocks = aiService.generateResponseBlocks(response);
      expect(blocks.some(b => b.type === 'rich_text')).toBe(true);
    });
  });

  describe('getGeminiModel', () => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    it('should create a model with correct params', async () => {
      const { Gemini } = await import('@google/adk');
      await aiService.getGeminiModel('my-model');
      expect(Gemini).toHaveBeenCalledWith(expect.objectContaining({
        model: 'my-model',
        vertexai: true
      }));
    });

    it('should include datastores if provided', async () => {
      const { Gemini } = await import('@google/adk');
      await aiService.getGeminiModel('my-model', ['ds1']);
      expect(Gemini).toHaveBeenCalledWith(expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            retrieval: expect.objectContaining({
              vertexAiSearch: expect.objectContaining({
                datastore: expect.stringContaining('ds1')
              })
            })
          })
        ])
      }));
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  });

  describe('_handlePromptCommand', () => {
    it('should run supervisor agent and post response', async () => {
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
      const event = {
        channel: 'C1',
        ts: '123',
        event_ts: '123.456',
        text: 'hi',
        user_id: 'U1'
      } as any;

      await aiService._handlePromptCommand(event);

      const mockRunner = vi.mocked(Runner).mock.results[0].value;
      expect(mockRunner.runAsync).toHaveBeenCalled();

      expect(slackAPI.postMessage).toHaveBeenCalledWith(
        'C1',
        expect.stringContaining('mocked response'),
        expect.any(Array),
        '123.456'
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
    });
  });
});

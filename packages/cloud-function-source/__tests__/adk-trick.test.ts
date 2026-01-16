import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LlmAgent,
  Runner,
  BuiltInCodeExecutor,
  InMemorySessionService,
  GOOGLE_SEARCH,
  LoggingPlugin,
  Gemini,
  Event,
  BasePlugin,
  AgentTool
} from '@google/adk';

// Define the trick locally for testing
class NoOpCodeExecutor extends BuiltInCodeExecutor {
  override async processLlmRequest() {
    // No-op
  }
}

/**
 * A test plugin to capture the tools sent to the LLM.
 * Short-circuits the model call to avoid complex ADK logic and network errors.
 */
class ToolCapturePlugin extends BasePlugin {
  capturedTools: string[] = [];

  constructor() {
    super('ToolCapturePlugin');
  }

  override async beforeModelCallback({ llmRequest }: any) {
    // console.log('DEBUG: llmRequest.config.tools:', JSON.stringify(llmRequest.config?.tools, null, 2));
    if (llmRequest.toolsDict) {
      this.capturedTools = Object.keys(llmRequest.toolsDict);
    }

    // Also check raw tools in config for grounding tools like Google Search
    if (llmRequest.config?.tools) {
      for (const t of llmRequest.config.tools) {
        if (t.googleSearchRetrieval || t.google_search_retrieval) this.capturedTools.push('googleSearchRetrieval');
        if (t.dynamicRetrieval || t.dynamic_retrieval) this.capturedTools.push('googleSearchRetrieval');
        if (t.codeExecution || t.code_execution) this.capturedTools.push('codeExecution');
      }
    }

    // SHORT-CIRCUIT: Return a mock response to skip actual model execution
    return {
      content: {
        role: 'model',
        parts: [{ text: '{"answer": "Captured tools: ' + this.capturedTools.join(', ') + '"}' }]
      },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    };
  }
}

describe('ADK Tool Injection Regression Tests', () => {
  // Use gemini-2.0 as ADK runner has specific checks for gemini-2 prefixed models for some features
  const mockModel = new Gemini({
    model: 'gemini-2.0-flash',
    project: 'test-project',
    location: 'us-central1',
    vertexai: true
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BASELINE: confirms that ADK Runner implicitly injects codeExecution tool into standard agents', async () => {
    // A simple sub-agent to use as a tool
    const subAgent = new LlmAgent({
      name: 'SubAgent',
      model: mockModel,
      instruction: 'Sub'
    });

    const agent = new LlmAgent({
      name: 'StandardAgent',
      model: mockModel,
      tools: [new AgentTool({ agent: subAgent })],
      instruction: 'Test'
    });

    const toolCapture = new ToolCapturePlugin();
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      agent,
      sessionService,
      appName: 'TestApp',
      plugins: [toolCapture]
    });

    const sessionId = 'test-session-' + Date.now();
    await sessionService.createSession({ userId: 'tester', sessionId, appName: 'TestApp' });

    // Execute runner
    const iterator = runner.runAsync({
      userId: 'tester',
      sessionId,
      newMessage: { role: 'user', parts: [{ text: 'Hello' }] }
    });

    // Need to trigger the model call (one next() is enough for Runner's pre-call logic)
    await iterator.next();

    // VERIFICATION:
    // If this test FAILS, it means ADK has been updated to stop injecting codeExecution implicitly.
    // At that point, the "Inheritance Trick" may no longer be necessary!
    expect(toolCapture.capturedTools).toContain('codeExecution');
    expect(toolCapture.capturedTools).toContain('SubAgent');
  });

  it('TRICK: verifies that NoOpCodeExecutor successfully suppresses codeExecution tool injection', async () => {
    // A simple sub-agent to use as a tool
    const subAgent = new LlmAgent({
      name: 'SubAgent',
      model: mockModel,
      instruction: 'Sub'
    });

    const agent = new LlmAgent({
      name: 'TrickAgent',
      model: mockModel,
      tools: [new AgentTool({ agent: subAgent })],
      instruction: 'Test',
      codeExecutor: new NoOpCodeExecutor() // THE TRICK
    });

    const toolCapture = new ToolCapturePlugin();
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      agent,
      sessionService,
      appName: 'TestApp',
      plugins: [toolCapture]
    });

    const sessionId = 'test-session-trick-' + Date.now();
    await sessionService.createSession({ userId: 'tester', sessionId, appName: 'TestApp' });

    // Execute runner
    const iterator = runner.runAsync({
      userId: 'tester',
      sessionId,
      newMessage: { role: 'user', parts: [{ text: 'Hello' }] }
    });

    await iterator.next();

    // VERIFICATION:
    // codeExecution must NOT be in the list
    expect(toolCapture.capturedTools).not.toContain('codeExecution');
    // sub-agent tool SHOULD still be there
    expect(toolCapture.capturedTools).toContain('SubAgent');
  });

  it('CANARY: detects if ADK logic changes its tool injection mechanism', async () => {
    // This test specifically checks for the 'BuiltInCodeExecutor' injection in the runner.
    // The runner.js source shows:
    // if (this.agent instanceof LlmAgent && !(this.agent.codeExecutor instanceof BuiltInCodeExecutor)) {
    //   this.agent.codeExecutor = new BuiltInCodeExecutor();
    // }

    const agent = new LlmAgent({
      name: 'CanaryAgent',
      model: mockModel,
      tools: [GOOGLE_SEARCH],
      instruction: 'Test'
    });

    // Check pre-runner state
    expect(agent.codeExecutor).toBeUndefined();

    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      agent,
      sessionService,
      appName: 'TestApp'
    });

    const sessionId = 'test-session-canary-' + Date.now();
    await sessionService.createSession({ userId: 'tester', sessionId, appName: 'TestApp' });

    // We must START the runAsync iterator to trigger the injection in the ADK runner
    const iterator = runner.runAsync({
      userId: 'tester',
      sessionId,
      newMessage: { role: 'user', parts: [{ text: 'Hello' }] }
    });

    // Take one step to reach the injection point code
    await iterator.next();

    // Check post-trigger state
    // IF THIS FAILS, it means ADK changed how it manages code executors.
    expect(agent.codeExecutor).toBeInstanceOf(BuiltInCodeExecutor);
  });
});

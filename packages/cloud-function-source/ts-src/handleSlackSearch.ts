import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GenerateContentParameters, GenerateContentResponse, GoogleGenAI, Content, Part } from '@google/genai';
import { Gemini } from '@google/adk';
import { ModelFunctionCallArgs } from './aiService';
import { getSecretValue } from './gcpAPI';
import util from 'node:util';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export async function handleSlackSearch(
  slackSummaryModel: Gemini,
  modelFunctionCallArgs: ModelFunctionCallArgs,
  generateContentRequest: GenerateContentParameters
): Promise<GenerateContentResponse> {

  if (!modelFunctionCallArgs.prompt) {
    throw new Error("modelFunctionCallArgs missing prompt");
  }

  const slackUserToken = await getSecretValue('AIBot', 'slackUserToken');
  const mcpServerUrl = await getSecretValue('AIBot', 'mcpSlackSearchUrl');

  // Initialize MCP Client
  // Using Streamable HTTP transport to connect to our Cloud Run MCP Server
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpServerUrl}/mcp`), {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${slackUserToken}`
      }
    }
  });

  const client = new Client({
    name: "aibot-client",
    version: "1.0.0",
  }, {
    capabilities: {}
  });

  await client.connect(transport);

  try {
    // Call the search tool on the MCP server
    const result = await client.callTool({
      name: "search_slack_messages",
      arguments: {
        query: modelFunctionCallArgs.prompt
      }
    }) as CallToolResult;

    const mcpContent = result.content[0];
    if (mcpContent.type !== "text") {
      throw new Error("Expected text response from MCP server");
    }
    const messages = JSON.parse(mcpContent.text);

    // Everything from here down is the original summary logic using the messages from MCP
    const prompt = `
      The data below is a set of Slack messages...
      ${util.inspect(messages, false, null)}
    `;

    const contents = generateContentRequest.contents as Content[];
    const lastUserContent = contents.findLast((content) => content.role === 'user');
    if (!lastUserContent) {
      throw new Error(`Could not find user content`);
    }
    const promptPart: Part = { text: prompt };
    lastUserContent.parts ??= [];
    lastUserContent.parts.push(promptPart);

    const apiClient = slackSummaryModel.apiClient as unknown as GoogleGenAI;
    const content = await apiClient.models.generateContent(generateContentRequest);

    return content;
  } finally {
    await client.close();
  }
}



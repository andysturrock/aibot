import { GenericMessageEvent } from '@slack/types';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { _handlePromptCommand } from '../ts-src/aiService';
import { PromptCommandPayload } from '../ts-src/slackAPI';

dotenv.config();

async function testHandlePromptCommand() {
  console.log("Starting Local AIBot Integration Runner (via vite-node)...");
  console.log("Commands: 'bye' to exit, or enter your prompt below.");

  const ts = (Date.now() / 1000).toFixed(6);
  const genericMessageEvent: GenericMessageEvent = {
    event_ts: ts,
    channel: "D07E055CQE8", // DM channel for testing
    type: 'message',
    subtype: undefined,
    user: 'U04K8GAUF0F',
    ts: ts,
    channel_type: 'im'
  };

  const event: PromptCommandPayload = {
    user_id: 'U04K8GAUF0F',
    text: '',
    bot_id: 'B07DXKZSTR8',
    bot_user_id: 'U07EAA605DF',
    team_id: 'TCPJP63PT',
    ...genericMessageEvent
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const text = await rl.question(`\nBot Prompt > `);
      if (text.toLowerCase() === "bye") break;

      event.text = text;
      try {
        await _handlePromptCommand(event);
        console.log("\n--- Execution Finished ---");
      } catch (err) {
        console.error("\n--- Execution Failed ---");
        console.error(err);
      }
    }
  } finally {
    rl.close();
  }
}

void testHandlePromptCommand();

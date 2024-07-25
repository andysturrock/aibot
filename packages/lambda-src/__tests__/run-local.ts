import {
  Content,
  FunctionCall
} from '@google-cloud/vertexai';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import util from 'util';
import { callModelFunction } from '../ts-src/handleAICommon';
import { _handlePromptCommand } from '../ts-src/handlePromptCommand';
import { PromptCommandPayload } from '../ts-src/slackAPI';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callCustomGroundedModel(prompt: string) {
  const functionCall: FunctionCall = {
    name: "call_custom_search_grounded_model",
    args: {prompt}
  };
  const functionResponse = await callModelFunction(functionCall, {});
  console.log(`functionResponse: ${util.inspect(functionResponse, false, null, true)}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callGoogleGroundedModel(prompt: string) {
  const functionCall: FunctionCall = {
    name: "call_google_search_grounded_model",
    args: {prompt}
  };
  const functionResponse = await callModelFunction(functionCall, {});
  console.log(`functionResponse: ${util.inspect(functionResponse, false, null, true)}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function testHandlePromptCommand() {
  const event: PromptCommandPayload = {
    user_id: '',
    text: '',
    bot_id: '',
    bot_user_id: '',
    team_id: '',
    event_ts: "1721893185.864729",
    channel: "C06KQCCSJMU"
  };
  let history: Content[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function getHistory(slackId: string, threadTs: string): Promise<Content[]> {
    return new Promise((resolve) => {
      resolve(history);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function putHistory(slackId: string, threadTs: string, newHistory: Content[]): Promise<void> {
    return new Promise((resolve) => {
      history = newHistory;
      resolve();
    });
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let text = await rl.question(`Input:`);
  while(text != "bye") {
    event.text = text;
    await _handlePromptCommand(event, getHistory, putHistory);
    text = await rl.question(`Input:`);
  }
}

// void callCustomGroundedModel("What is the daily meal rate for expenses?");
// void callGoogleGroundedModel("You are the CTO of a digital bank. Write a paper for the board advising them about AI and the approach the bank should take in adopting it.");
void testHandlePromptCommand();

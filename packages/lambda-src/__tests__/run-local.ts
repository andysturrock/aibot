import {
  Content
} from '@google-cloud/vertexai';
import { GenericMessageEvent } from '@slack/bolt';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { downloadSlackContent } from '../ts-src/downloadSlackContent';
import { _handlePromptCommand } from '../ts-src/handlePromptCommand';
import { PromptCommandPayload } from '../ts-src/slackAPI';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function testHandlePromptCommand() {
  const genericMessageEvent: GenericMessageEvent = {
    event_ts: "1721893185.864729",
    channel: "C06KQCCSJMU",
    type: 'message',
    subtype: undefined,
    user: '',
    ts: '',
    channel_type: 'channel'
  };
  const event: PromptCommandPayload = {
    user_id: '',
    text: '',
    bot_id: '',
    bot_user_id: '',
    team_id: '',
    ...genericMessageEvent
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
// void testHandlePromptCommand();
async function testDownloadSlackContent() {
  await downloadSlackContent();
}

try {
  void testDownloadSlackContent();
}
catch(error) {
  console.error(error);
}
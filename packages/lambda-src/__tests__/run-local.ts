import { Content } from '@google/genai';
import { GenericMessageEvent } from '@slack/types';
import * as dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { _handlePromptCommand } from '../ts-src/aiService';
import { PromptCommandPayload } from '../ts-src/slackAPI';
dotenv.config();


async function testHandlePromptCommand() {
  const genericMessageEvent: GenericMessageEvent = {
    event_ts: "1721893185.864729",
    channel: "C06KQCCSJMU",
    type: 'message',
    subtype: undefined,
    user: '',
    ts: '1721893185.864729',
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
  function getHistory(_channelId: string, _threadTs: string, _agentName: string): Promise<Content[] | undefined> {
    return Promise.resolve(history);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function putHistory(_channelId: string, _threadTs: string, newHistory: Content[], _agentName: string): Promise<void> {
    history = newHistory;
    return Promise.resolve();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let text = await rl.question(`Input:`);
  while (text != "bye") {
    event.text = text;
    await _handlePromptCommand(event, getHistory as any, putHistory as any);
    text = await rl.question(`Input:`);
  }
}


void testHandlePromptCommand();

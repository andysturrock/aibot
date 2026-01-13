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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let text = await rl.question(`Input:`);
  while (text != "bye") {
    event.text = text;
    await _handlePromptCommand(event);
    text = await rl.question(`Input:`);
  }
}


void testHandlePromptCommand();

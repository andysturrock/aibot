import util from 'node:util';
import { _handlePromptCommand, PromptCommandPayload } from './aiService';

export async function handlePromptCommand(event: PromptCommandPayload) {
  console.log(`handlePromptCommand event ${util.inspect(event, false, null)}`);
  await _handlePromptCommand(event);
}

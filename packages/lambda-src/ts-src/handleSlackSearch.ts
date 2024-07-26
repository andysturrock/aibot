import { GenerativeModel, GenerativeModelPreview } from '@google-cloud/vertexai';
import util from 'util';

export async function handleSlackSearch(slackSummaryModel: GenerativeModel | GenerativeModelPreview, argsObj: object) {
  console.log(`handleSlackSearch argsObj: ${util.inspect(argsObj, false, null)}`);
  type Args = {
    prompt?: string
  };
  const args = argsObj as Args;
  if(!args.prompt) {
    throw new Error(`Missing prompt argument in ${util.inspect(argsObj, false, null)}`);
  }
  try {
    const request = "Say you don't know";
    
    return await slackSummaryModel.generateContent(request);
  }
  catch (error) {
    console.error(error);
    console.error(util.inspect(error, false, null));
  }
}

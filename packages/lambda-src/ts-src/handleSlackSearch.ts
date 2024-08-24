import { GenerateContentRequest, GenerativeModel, GenerativeModelPreview, TextPart } from '@google-cloud/vertexai';
import util from 'util';
import { ModelFunctionCallArgs } from './handleAICommon';

export async function handleSlackSearch(slackSummaryModel: GenerativeModel | GenerativeModelPreview,
  modelFunctionCallArgs: ModelFunctionCallArgs,
  generateContentRequest: GenerateContentRequest) {
  
  const prompt = `
    search for this
  `;

  // Search backwards through the content until we find the most recent user part, which should be the original prompt.
  // Then add a text part to that with all the detail above.
  const lastUserContent = generateContentRequest.contents.findLast(content => content.role == 'user');
  if(!lastUserContent) {
    throw new Error(`Could not find user content in generateContentRequest: ${util.inspect(generateContentRequest, false, null)}`);
  }
  const promptPart: TextPart = {
    text: prompt
  };
  lastUserContent.parts.push(promptPart);
  return await slackSummaryModel.generateContent(generateContentRequest);
}

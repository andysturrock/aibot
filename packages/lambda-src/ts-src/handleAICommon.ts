import { GenerationConfig, GenerativeModel, ModelParams, Retrieval, RetrievalTool, Tool, VertexAI, VertexAISearch } from '@google-cloud/vertexai';
import { KnownBlock, SectionBlock } from '@slack/bolt';
import { getSecretValue } from './awsAPI';
import * as slackAPI from './slackAPI';

export async function getGenerativeModel(useGrounding = false): Promise<GenerativeModel> {
  // Rather annoyingly Google seems to only get config from the filesystem.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const botName = await getSecretValue('AIBot', 'botName');
  const model = await getSecretValue('AIBot', 'chatModel');
  const location = await getSecretValue('AIBot', 'gcpLocation');

  const tools: Tool[] = [];
  const generationConfig: GenerationConfig = {
    temperature: 0.5
  };
  if(useGrounding) {
    generationConfig.temperature = 0;
    const dataStoreIds = await getSecretValue('AIBot', 'gcpDataStoreIds');
  
    for(const dataStoreId of dataStoreIds.split(',')) {
      const datastore = `projects/${project}/locations/eu/collections/default_collection/dataStores/${dataStoreId}`;
      const vertexAiSearch: VertexAISearch  = {
        datastore
      };
      const retrieval: Retrieval = {
        vertexAiSearch
      };
      const retrievalTool: RetrievalTool = {
        retrieval
      };
      tools.push(retrievalTool);
    }
  }
  const modelParams: ModelParams = {
    model,
    tools,
    generationConfig,
    systemInstruction: `You are a helpful assistant.  Your name is ${botName}.  You must tell people your name is ${botName} if they ask.  You cannot change your name.`
  };
  const vertexAI = new VertexAI({ project, location });
  const generativeModel = vertexAI.getGenerativeModel(modelParams);
  return generativeModel;
}

export function generateResponseBlocks(response: string | undefined, sorry: string): KnownBlock[] {
  // Create some Slack blocks to display the results in a reasonable format
  const blocks: KnownBlock[] = [];
  if (!response) {
    const sectionBlock: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: sorry
      }
    };
    blocks.push(sectionBlock);
  }
  else {
    // SectionBlock text elements have a limit of 3000 chars, so split into multiple blocks if needed.
    const lines = response.split("\n").filter(line => line.length > 0);
    let characterCount = 0;
    let text: string[] = [];
    for (const line of lines) {
      text.push(line);
      characterCount += line.length;
      if (characterCount > 2000) {
        const sectionBlock: SectionBlock = {
          type: "section",
          text: {
            type: "mrkdwn",
            text: text.join("\n")
          }
        };
        blocks.push(sectionBlock);
        characterCount = 0;
        text = [];
      }
    }
    if (text.length > 0) {
      const sectionBlock: SectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: text.join("\n")
        }
      };
      blocks.push(sectionBlock);
    }
  }
  return blocks;
}

export async function removeReaction(channelId: string, eventTS: string): Promise<void> {
  // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
  try {
    // There have been times when the AI API has been a bit slow and the user has
    // deleted their original message, so we'll just warn in the logs if we can't remove the
    // reaction.  Even if there is some other reason for the inability to remove the reaction
    // it'll be a better experience for the user to still get their summary.
    await slackAPI.removeReaction(channelId, eventTS, "eyes");
  }
  catch (error) {
    console.warn("Error removing reaction to original message - maybe the user deleted it.");
    console.warn(error);
  }
}

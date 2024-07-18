import {
  GenerationConfig,
  GenerativeModel,
  GoogleSearchRetrieval,
  GoogleSearchRetrievalTool,
  GroundingAttributionWeb,
  HarmBlockThreshold,
  HarmCategory,
  ModelParams,
  Retrieval,
  RetrievalTool,
  SafetySetting,
  Tool,
  VertexAI,
  VertexAISearch
} from '@google-cloud/vertexai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/bolt';
import { getSecretValue } from './awsAPI';
import * as slackAPI from './slackAPI';

export type GetGenerativeModelParams = {
  useGoogleSearchGrounding: boolean,
  useCustomSearchGrounding: boolean
};

export async function getGenerativeModel(params: GetGenerativeModelParams = {useGoogleSearchGrounding: true, useCustomSearchGrounding: false}): Promise<GenerativeModel> {
  // Rather annoyingly Google seems to only get config from the filesystem.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "./clientLibraryConfig-aws-aibot.json";
  const project = await getSecretValue('AIBot', 'gcpProjectId');
  const botName = await getSecretValue('AIBot', 'botName');
  const model = await getSecretValue('AIBot', 'chatModel');
  const location = await getSecretValue('AIBot', 'gcpLocation');

  const tools: Tool[] = [];
  const generationConfig: GenerationConfig = {
    temperature: 1.0,
    maxOutputTokens: 8192,
    topP: 0.95
  };
  const safetySettings: SafetySetting[] = [];
  safetySettings.push(
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    },
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
    }
  );

  if(params.useCustomSearchGrounding) {
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
  if(params.useGoogleSearchGrounding) {
    // Google search grounding is a useful way to overcome dated training data, hence default to true.
    const googleSearchRetrieval: GoogleSearchRetrieval = {
      disableAttribution: false
    };
    const googleSearchRetrievalTool: GoogleSearchRetrievalTool = {
      googleSearchRetrieval
    };
    tools.push(googleSearchRetrievalTool);
  }

  const modelParams: ModelParams = {
    model,
    tools,
    safetySettings,
    generationConfig,
    systemInstruction: `You are a helpful assistant.  Your name is ${botName}.  You must tell people your name is ${botName} if they ask.  You cannot change your name.`
  };
  const vertexAI = new VertexAI({ project, location });
  const generativeModel = vertexAI.getGenerativeModel(modelParams);
  return generativeModel;
}

export function generateResponseBlocks(response: string | undefined, sorry: string, attributions: GroundingAttributionWeb[] = []): KnownBlock[] {
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
    // Do some basic translation of Google's markdown (which seems fairly standard)
    // to Slack markdown (which is not).
    response = response.replaceAll('**', '*');
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
    // Add a section with attributions if there were any.
    if(attributions.length > 0) {
      let elements: RichTextSection[] = [];
      elements = attributions.reduce((elements, attribution) => {
        if(attribution.uri) {
          const richTextLink: RichTextLink = {
            type: "link",
            url: attribution.uri,
            text: attribution.title
          };
          const richTextSection: RichTextSection = {
            type: "rich_text_section",
            elements: [richTextLink]
          };
          elements.push(richTextSection);
        }
        return elements;
      }, elements);
    
      const richTextList: RichTextList = {
        type: "rich_text_list",
        style: "ordered",
        elements
      };

      const richTextText: RichTextText = {
        type: "text",
        text: "References",
        style: {bold: true}
      };
      const richTextSection: RichTextSection = {
        type: "rich_text_section",
        elements: [richTextText]
      };
      const richTextBlock: RichTextBlock = {
        type: "rich_text",
        elements: [richTextSection, richTextList]
      };
      blocks.push(richTextBlock);
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

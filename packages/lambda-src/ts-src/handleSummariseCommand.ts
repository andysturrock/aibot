import { GroundingAttributionWeb } from '@google-cloud/vertexai';
import { KnownBlock, RichTextBlock, RichTextLink, RichTextList, RichTextSection, RichTextText, SectionBlock } from '@slack/bolt';
import util from 'util';
import { getSecretValue } from './awsAPI';
import { getGenerativeModel } from './handleAICommon';
import { PromptCommandPayload, getChannelMessages, getThreadMessages, postEphmeralErrorMessage, postErrorMessageToResponseUrl, postMessage, removeReaction } from './slackAPI';

export async function handleSummariseCommand(event: PromptCommandPayload): Promise<void> {
  const responseUrl = event.response_url;
  const channelId = event.channel;
  try {
    const botName = await getSecretValue('AIBot', 'botName');
    const generativeModel = await getGenerativeModel();

    // If we have been invoked by the "lumos" command we'll make the summary more sassy.
    const sassy = event.text.toLowerCase().includes("lumos") ? "Make the summary really sassy." : "";

    // If the event has a thread_ts field we'll summarise the thread.
    // Else we'll summarise the channel.
    let request = "";
    if(event.thread_ts && event.channel) {
      const messages = await getThreadMessages(event.channel, event.thread_ts);
      const texts: string[] = [];
      for(const message of messages) {
        texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
      }
      request = `This is a collection of messages in a thread in a Slack channel in the format "date - user: message".
        When you see a string like <@XYZ123> that is a user id.
        Refer to the user by that user id in your answer.  Keep the < and the > characters around the user id.
        Try to include dates in your answer.
        Please summarise the messages below.
        ${sassy}
        ${texts.join("\n")}`;
    }
    else if(event.channel) {
      const thirtyDaysAgo = new Date(new Date().getTime() - (30 * 24 * 60 * 60 * 1000));
      // Slack's timestamps are in seconds rather than ms.
      const messages = await getChannelMessages(event.channel, `${thirtyDaysAgo.getTime() / 1000}`, true);
      // Messages are returned most recent at the start of the array, so swap that round.
      messages.reverse();
      const texts: string[] = [];
      for(const message of messages) {
        texts.push(`${message.date ? message.date.toISOString() : "unknown"} - ${message.user}: ${message.text}`);
      }
      request = `This is a collection of messages in a Slack channel in the format "date - user: message".
        When you see a string like <@XYZ123> that is a user id.
        Refer to the user by that user id in your answer.  Keep the < and the > characters around the user id.
        Try to include dates in your answer.
        Please summarise the messages below.
        ${sassy}
        ${texts.join("\n")}`;
    }
    else {
      throw new Error("Need channel or thread_ts field in event");
    }

    const sorry = "Sorry - I couldn't summarise that.";
    const generateContentResult = await generativeModel.generateContent(request);
    const contentResponse = generateContentResult.response;
    const response = contentResponse.candidates? contentResponse.candidates[0].content.parts[0].text : sorry;

    const blocks = generateSummaryResponseBlocks(response, sorry);
        
    if(channelId && event.event_ts) {
      // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
      await _removeReaction(channelId, event.event_ts);
      await postMessage(channelId, `${botName} summary`, blocks, event.event_ts);
    }
    
  }
  catch (error) {
    console.error(error);
    console.error(util.inspect(error, false, null));
    if(responseUrl) {
      await postErrorMessageToResponseUrl(responseUrl, "Failed to call AI API");
    }
    else if(channelId) {
      await postEphmeralErrorMessage(channelId, event.user_id, "Failed to call AI API");
    }
  }
}

export async function _removeReaction(channelId: string, eventTS: string): Promise<void> {
  // Remove the eyes emoji from the original message so we don't have eyes littered everywhere.
  try {
    // There have been times when the AI API has been a bit slow and the user has
    // deleted their original message, so we'll just warn in the logs if we can't remove the
    // reaction.  Even if there is some other reason for the inability to remove the reaction
    // it'll be a better experience for the user to still get their summary.
    await removeReaction(channelId, eventTS, "eyes");
  }
  catch (error) {
    console.warn("Error removing reaction to original message - maybe the user deleted it.");
    console.warn(error);
  }
}

export function generateSummaryResponseBlocks(response: string | undefined, sorry: string, attributions: GroundingAttributionWeb[] = []): KnownBlock[] {
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


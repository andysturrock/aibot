import { Block, SectionBlock } from "@slack/bolt";

export function generateImmediateSlackResponseBlocks() {
  const blocks: Block[] = [];
  const sectionBlock: SectionBlock = {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "Thinking..."
    }
  };
  blocks.push(sectionBlock);
  return {blocks, text: "Thinking..."};
}

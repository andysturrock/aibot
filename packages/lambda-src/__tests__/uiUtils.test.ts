import { describe, it, expect } from 'vitest';
import { generateImmediateSlackResponseBlocks } from '../ts-src/generateImmediateSlackResponseBlocks';
import { generateLoggedInHTML } from '../ts-src/generateLoggedInHTML';

describe('uiUtils', () => {
  describe('generateImmediateSlackResponseBlocks', () => {
    it('should return Thinking... blocks', () => {
      const result = generateImmediateSlackResponseBlocks();
      expect(result.text).toBe('Thinking...');
      expect(result.blocks[0]).toMatchObject({
        type: 'section',
        text: { text: 'Thinking...' }
      });
    });
  });

  describe('generateLoggedInHTML', () => {
    it('should return HTML with provider name', () => {
      const html = generateLoggedInHTML('Slack');
      expect(html).toContain('Authentication Success');
      expect(html).toContain('Slack');
    });
  });
});

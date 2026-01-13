import { vi, describe, it, expect, beforeEach } from 'vitest';
import { handleHomeTabEvent } from '../ts-src/handleHomeTabEvent';
import { AppHomeOpenedEvent } from '@slack/types';
import * as awsAPI from '../ts-src/awsAPI';
import * as slackAPI from '../ts-src/slackAPI';
import * as tokensTable from '../ts-src/tokensTable';

vi.mock('../ts-src/awsAPI');
vi.mock('../ts-src/slackAPI');
vi.mock('../ts-src/tokensTable');

describe('handleHomeTabEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(awsAPI.getSecretValue).mockResolvedValue('TestBot');
  });

  it('should show authorized message if token exists', async () => {
    vi.mocked(tokensTable.getAccessToken).mockResolvedValue('token');
    const event = { user: 'U1' } as AppHomeOpenedEvent;

    await handleHomeTabEvent(event);
    expect(slackAPI.publishHomeView).toHaveBeenCalledWith('U1', expect.arrayContaining([
      expect.objectContaining({
        text: expect.objectContaining({ text: expect.stringContaining('authorised') as never }) as never
      }) as never
    ]));
  });

  it('should show unauthorized message and button if token missing', async () => {
    vi.mocked(tokensTable.getAccessToken).mockResolvedValue(undefined);
    const event = { user: 'U1' } as AppHomeOpenedEvent;

    await handleHomeTabEvent(event);
    expect(slackAPI.publishHomeView).toHaveBeenCalledWith('U1', expect.arrayContaining([
      expect.objectContaining({
        text: expect.objectContaining({ text: expect.stringContaining('not authorised') as never }) as never
      }) as never,
      expect.objectContaining({ type: 'actions' }) as never
    ]));
  });
});

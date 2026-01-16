import { vi, describe, it, expect, beforeEach } from 'vitest';
import { handleHomeTabEvent } from '../ts-src/handleHomeTabEvent';
import { AppHomeOpenedEvent } from '@slack/types';
import * as gcpAPI from '../ts-src/gcpAPI';
import * as slackAPI from '../ts-src/slackAPI';
import * as tokensTable from '../ts-src/gcpTokensTable';

vi.mock('../ts-src/gcpAPI');
vi.mock('../ts-src/slackAPI');
vi.mock('../ts-src/gcpTokensTable');

describe('handleHomeTabEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gcpAPI.getSecretValue).mockResolvedValue('TestBot');
  });

  it('should show authorized message if token exists', async () => {
    vi.mocked(tokensTable.getAccessToken).mockResolvedValue('token');
    const event = { user: 'U1' } as AppHomeOpenedEvent;

    await handleHomeTabEvent(event);
    expect(slackAPI.publishHomeView).toHaveBeenCalledWith('U1', expect.arrayContaining([
      expect.objectContaining({
        text: expect.objectContaining({ text: expect.stringContaining('authorised') as any }) as any
      }) as any
    ]));
  });

  it('should show unauthorized message and button if token missing', async () => {
    vi.mocked(tokensTable.getAccessToken).mockResolvedValue(undefined);
    const event = { user: 'U1' } as AppHomeOpenedEvent;

    await handleHomeTabEvent(event);
    expect(slackAPI.publishHomeView).toHaveBeenCalledWith('U1', expect.arrayContaining([
      expect.objectContaining({
        text: expect.objectContaining({ text: expect.stringContaining('not authorised') as any }) as any
      }) as any,
      expect.objectContaining({ type: 'actions' }) as any
    ]));
  });
});

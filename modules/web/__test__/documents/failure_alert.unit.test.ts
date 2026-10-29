// A crawl that fails raises an alert with a screenshot of the page it failed
// on. The screenshot is incidental: a host that cannot keep it still gets the
// alert, and the read still fails with its own reason.

import { fakeBrowser } from 'movement-engine/public/testing';

import { documentReader } from '../../documents/reader';
import { readerHost } from './reader_host';
import { BRIEFLINK_URL, brieflinkSite } from './sites';

describe('a failed crawl’s alert', () => {
  it('is sent when the screenshot cannot be kept', async () => {
    const host = {
      ...readerHost(fakeBrowser(brieflinkSite()).slot),
      keepScreenshot: async (): Promise<string> => {
        throw new Error('no screenshot storage on this host');
      },
    };

    await expect(documentReader(host).getUrlAsPdfStream(BRIEFLINK_URL, {})).rejects.toThrow('This BriefLink needs an email to view');
    expect(host.alerts).toEqual([{ channel: 'DEALFLOW', opsTitle: `Crawler failed to fetch anything from ${BRIEFLINK_URL}` }]);
    expect(host.errors).toEqual([]);
  });
});

// DocSend's consent banner and drawer tab are kept off the gate form and the
// slide captures by a stylesheet rule on each document, put in before the form
// is touched and again before the slides are captured (Continue reloads the
// page, which brings a fresh banner). The scripted page runs no script, so
// what is checked is that the page was asked, and when.

import { fakeBrowser } from 'movement-engine/public/testing';

import { documentReader } from '../../documents/reader';
import { overridingPages } from './page_overrides';
import { readerHost } from './reader_host';
import { DOCSEND_SLIDES, DOCSEND_URL, bytesOf, docsendSite, pageCount } from './sites';

const HIDE_CHROME = 'hide #ccpa-iframe, div.drawer_tab { display: none !important; }';

describe('DocSend’s page chrome', () => {
  it('is hidden before the gate is filled and again before the slides are captured', async () => {
    const site = docsendSite();
    const slot = overridingPages(fakeBrowser(site).slot, () => ({
      evaluate: async (_fn: unknown, arg?: unknown): Promise<never> => {
        site.events.push(`hide ${String(arg)}`);
        throw new Error('the scripted page runs no script');
      },
    }));

    const pdf = await documentReader(readerHost(slot)).getUrlAsPdfStream(DOCSEND_URL, { email: 'ada@acme.test' });

    expect(site.events).toEqual([HIDE_CHROME, 'fill ada@acme.test', 'continue', HIDE_CHROME, 'capture 1', 'capture 2', 'capture 3']);
    expect(pageCount(await bytesOf(pdf!.data))).toBe(DOCSEND_SLIDES);
  }, 40_000);
});

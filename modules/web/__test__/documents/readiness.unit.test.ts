// A share page whose DOM is in but whose `load` event never comes (a tracker
// holding it open) is still read: navigation waits for the DOM, then for the
// source's own sign that it has rendered. A source that knows its markup
// (DocSend) fails naming what never appeared, and follows a hand-off to
// another site.

import { fakeBrowser, type FakeSite } from 'movement-engine/public/testing';

import { documentReader } from '../../documents/reader';
import { loadNeverFires, overridingPages } from './page_overrides';
import { readerHost } from './reader_host';
import { BRIEFLINK_SLIDES, BRIEFLINK_URL, DOCSEND_URL, brieflinkSite, bytesOf, docsendSite, pageCount } from './sites';

describe('a share page whose load event never comes', () => {
  it('is captured once the DOM is in (a source with no readiness signal of its own)', async () => {
    const site = brieflinkSite();
    const page = loadNeverFires(fakeBrowser(site).slot);
    const reader = documentReader(readerHost(page.slot));

    const pdf = await reader.getUrlAsPdfStream(BRIEFLINK_URL, { email: 'ada@acme.test' });

    expect(page.waitedFor).toEqual(['domcontentloaded']);
    expect(pageCount(await bytesOf(pdf!.data))).toBe(BRIEFLINK_SLIDES);
  }, 20_000);

  it('reaches DocSend’s gate once the gate is visible', async () => {
    const page = loadNeverFires(fakeBrowser(docsendSite()).slot);
    const reader = documentReader(readerHost(page.slot));

    await expect(reader.getUrlAsPdfStream(DOCSEND_URL, {})).rejects.toThrow('This DocSend link needs an email to view');
  });

  it('fails a DocSend page that shows neither its gate nor its viewer, saying so', async () => {
    const host = readerHost(loadNeverFires(fakeBrowser(docsendSite({ blank: true })).slot).slot);

    await expect(documentReader(host).getUrlAsPdfStream(DOCSEND_URL, {})).resolves.toBeNull();
    expect(host.errors).toEqual([expect.objectContaining({ message: 'DocSend showed neither its email gate nor its viewer within 30s' })]);
  });

  it('follows DocSend handing the visitor to another site', async () => {
    const brieflink = brieflinkSite();
    const site: FakeSite = { open: (url) => brieflink.open(url) };
    const redirected = overridingPages(loadNeverFires(fakeBrowser(site).slot).slot, (page) => ({
      goto: (url, options) => page.goto(url === DOCSEND_URL ? BRIEFLINK_URL : url, options),
    }));
    const reader = documentReader(readerHost(redirected));

    const pdf = await reader.getUrlAsPdfStream(DOCSEND_URL, { email: 'ada@acme.test' });

    expect(pageCount(await bytesOf(pdf!.data))).toBe(BRIEFLINK_SLIDES);
  }, 20_000);
});

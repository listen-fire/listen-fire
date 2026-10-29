// A Papermark link read through the browser slot, with a scripted page in
// place of a browser. An email-gated deck comes out as a PDF with one page per
// deck page, the kind DocSend's crawler builds, for both of Papermark's
// viewers (pages turned with "next", or stacked and scrolled). The gates a
// crawler must not push through (an NDA, a one-time code sent to an inbox,
// an email gate with no email to give) are refused, saying which.

import { ONE_PIXEL_PNG, fakeBrowser, type FakeDocument, type FakeSite } from 'movement-engine/public/testing';

import { documentReader } from '../../documents/reader';
import { readerHost } from './reader_host';
import { bytesOf, pageCount } from './sites';

const DECK_URL = 'https://www.papermark.com/view/acme-seed';

interface Variant {
  pages: number;
  gate: 'none' | 'email' | 'nda' | 'otp';
  layout: 'horizontal' | 'vertical';
}

/** What the crawler did to the page. */
interface Records {
  typed: string[];
  submitted: boolean;
  agreementClicked: boolean;
  /** The page each capture of a turned page showed (the horizontal viewer). */
  captured: number[];
}

/** Papermark's view page as its crawler sees it (selectors as in papermark.ts). */
function papermarkSite({ pages, gate, layout }: Variant): FakeSite & { records: Records } {
  const records: Records = { typed: [], submitted: false, agreementClicked: false, captured: [] };
  let email = '';
  let stage: 'gate' | 'otp' | 'viewer' = gate === 'none' ? 'viewer' : 'gate';
  let current = 1;
  const pageImage = (n: number) => ({ box: { x: 0, y: 0, width: 960, height: 540 }, screenshot: () => (records.captured.push(n), ONE_PIXEL_PNG) });
  const containers = () =>
    Array.from({ length: pages }, (_, i) => ({ visible: layout === 'vertical' || i + 1 === current }));

  const document: FakeDocument = {
    title: () => 'Acme Seed Deck',
    query(selector) {
      if (stage === 'gate') {
        switch (selector) {
          case 'input[name="email"]':
            return [{ fill: (value) => ((email = value), void records.typed.push(value)) }];
          case 'input[name="name"]':
          case '#agreement':
            return gate === 'nda' ? [{ click: () => (records.agreementClicked = true) }] : [];
          case 'button[type="submit"]':
            return [
              {
                enabled: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && gate !== 'nda',
                click: () => ((records.submitted = true), (stage = gate === 'otp' ? 'otp' : 'viewer')),
              },
            ];
          default:
            return [];
        }
      }
      if (stage === 'otp') return selector === 'input[autocomplete="one-time-code"]' ? [{}] : [];
      if (current > pages) return selector === '.stats' ? [{}] : [];
      switch (selector) {
        case '.viewer-container':
          return containers();
        case '.viewer-container.hidden':
          return containers().filter((c) => !c.visible);
        case '.viewer-container:not(.hidden)':
          return containers().filter((c) => c.visible);
        case '.viewer-container:not(.hidden) >> img.viewer-image-mobile':
          return [pageImage(current)];
        case '.viewer-container >> img.viewer-image-mobile':
          return Array.from({ length: pages }, (_, i) => pageImage(i + 1));
        case 'button:has(> svg.lucide-chevron-right)':
          return layout === 'horizontal' && current < pages ? [{ click: () => (current += 1) }] : [];
        default:
          return [];
      }
    },
  };
  return {
    records,
    open(url) {
      if (url !== DECK_URL) throw new Error(`fake Papermark: nothing at ${url}`);
      return document;
    },
  };
}

/** Start a read; the test awaits the PDF it answers. */
function read(variant: Variant, email?: string) {
  const site = papermarkSite(variant);
  const browser = fakeBrowser(site);
  const pdf = documentReader(readerHost(browser.slot)).getUrlAsPdfStream(DECK_URL, email === undefined ? {} : { email });
  return { pdf, records: site.records, closed: browser.closed };
}

describe('a Papermark link through the browser slot', () => {
  it('gets past the email gate and captures every page of a horizontal deck', async () => {
    const { pdf, records, closed } = read({ pages: 5, gate: 'email', layout: 'horizontal' }, 'ada@acme.test');

    const deck = await pdf;
    expect(deck?.name).toBe('Acme Seed Deck.pdf');
    const bytes = await bytesOf(deck!.data);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(bytes)).toBe(5);
    expect(records.typed).toEqual(['ada@acme.test']);
    expect(records.captured).toEqual([1, 2, 3, 4, 5]);
    expect(closed()).toBe(1);
  });

  it('captures every page of a vertical deck with no gate', async () => {
    const { pdf, records } = read({ pages: 3, gate: 'none', layout: 'vertical' });

    expect(pageCount(await bytesOf((await pdf)!.data))).toBe(3);
    expect(records.submitted).toBe(false);
  });

  it('captures a one-page deck', async () => {
    const { pdf } = read({ pages: 1, gate: 'email', layout: 'horizontal' }, 'ada@acme.test');

    expect(pageCount(await bytesOf((await pdf)!.data))).toBe(1);
  });

  it('refuses an email gate it was given no email for, rather than guessing one', async () => {
    const { pdf, records } = read({ pages: 3, gate: 'email', layout: 'horizontal' });

    await expect(pdf).rejects.toThrow('This Papermark link needs an email to view');
    expect(records.submitted).toBe(false);
  });

  it('never accepts an NDA on the firm’s behalf', async () => {
    const { pdf, records } = read({ pages: 3, gate: 'nda', layout: 'horizontal' }, 'ada@acme.test');

    await expect(pdf).rejects.toThrow('asks the viewer to accept an NDA');
    expect(records.agreementClicked).toBe(false);
    expect(records.typed).toEqual([]);
    expect(records.submitted).toBe(false);
  });

  it('refuses a link that emails a one-time code', async () => {
    const { pdf, records } = read({ pages: 3, gate: 'otp', layout: 'horizontal' }, 'ada@acme.test');

    await expect(pdf).rejects.toThrow('emails a one-time code to ada@acme.test');
    expect(records.submitted).toBe(true);
  });
});

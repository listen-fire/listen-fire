// Gated sources as their crawlers see them, scripted for the fake browser,
// and what a test reads off the PDF a read answers.

import { ONE_PIXEL_PNG, type FakeDocument, type FakeSite } from 'movement-engine/public/testing';

export const BRIEFLINK_URL = 'https://brieflink.com/v/acme-seed';
export const BRIEFLINK_SLIDES = 3;

/** BriefLink: an email form, then a gallery of three slides with a next
 *  button disabled on the last. */
export function brieflinkSite(): FakeSite & { typed: string[]; document: FakeDocument } {
  const typed: string[] = [];
  let authenticated = false;
  let slide = 0;
  const document: FakeDocument = {
    title: () => 'Acme Seed Deck',
    query(selector) {
      switch (selector) {
        case 'input[name="email"]':
          return authenticated ? [] : [{ fill: (value) => void typed.push(value) }];
        case 'input[name="passcode"]':
          return [];
        case 'button[type="submit"]':
          return authenticated ? [] : [{ click: () => (authenticated = true) }];
        case '.DeckGalleryPageContainer':
          return authenticated ? [{ box: { x: 0, y: 0, width: 1024, height: 576 } }] : [];
        case 'button.Button.Right':
          return [{ enabled: slide < BRIEFLINK_SLIDES - 1, click: () => (slide += 1) }];
        default:
          return [];
      }
    },
  };
  return {
    typed,
    document,
    open(url) {
      if (url !== BRIEFLINK_URL) throw new Error(`fake BriefLink: nothing at ${url}`);
      return document;
    },
  };
}

export const DOCSEND_URL = 'https://docsend.com/view/acme-seed';
export const DOCSEND_SLIDES = 3;

/** DocSend: an email gate whose Continue opens a paginated viewer of three
 *  slides, the stats page after the last. With `blank`, a page that never
 *  draws its gate or its viewer. `events` keeps what was typed and clicked. */
export function docsendSite({ blank = false }: { blank?: boolean } = {}): FakeSite & { events: string[] } {
  const events: string[] = [];
  let authenticated = false;
  let slide = 0;
  const document: FakeDocument = {
    title: () => 'Acme Seed Deck',
    query(selector) {
      if (blank) return [];
      if (!authenticated) {
        switch (selector) {
          case '#link_auth_form_email':
            return [{ fill: (value) => void events.push(`fill ${value}`) }];
          case 'role=button[name="Continue"]':
            return [{ click: () => ((authenticated = true), events.push('continue')) }];
          default:
            return [];
        }
      }
      switch (selector) {
        case '#nextPageIcon':
          return [{ click: () => (slide += 1) }];
        case '.toolbar-page-indicator':
          return [{ text: `${slide + 1} / ${DOCSEND_SLIDES}` }];
        case 'div.item.active img.page-view':
          return slide < DOCSEND_SLIDES ? [{ box: { x: 0, y: 0, width: 1024, height: 576 }, screenshot: () => (events.push(`capture ${slide + 1}`), ONE_PIXEL_PNG) }] : [];
        case '#stats-content':
          return slide >= DOCSEND_SLIDES ? [{}] : [];
        default:
          return [];
      }
    },
  };
  return {
    events,
    open(url) {
      if (url !== DOCSEND_URL) throw new Error(`fake DocSend: nothing at ${url}`);
      return document;
    },
  };
}

export async function bytesOf(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The pages of a PDF jsPDF wrote. */
export function pageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
}

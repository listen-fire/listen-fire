import type { BrowserLocator } from 'movement-engine/public/browser';
import type { ExternalUrl, PdfStream } from './reader';

import { Crawler, FetchedDocument, Screenshot, READY_TIMEOUT, anyVisible, keepHidden, pollUntil } from './crawler';
import { logger, readerHost } from './host';
import { SECOND } from './waits';

// What a Papermark link renders, read from Papermark's own source
// (github.com/mfts/papermark at ed19717):
//
// - The gate: one form holding whichever fields the link was set up with (an
//   email, a password, and for an NDA a name and an agreement checkbox), and
//   one submit ("Continue") that stays disabled until every field is valid.
// - For a link that verifies emails, after the gate: a one-time code sent to
//   that inbox.
// - The horizontal viewer: every page drawn up front as a container, all but
//   the current one `hidden`, each holding one page image that shows a blank
//   placeholder until it is fetched. "Next" is a button around lucide's
//   chevron, there while a next page is. A stats slide with no container may
//   follow the last page.
// - The vertical viewer: the same containers, none hidden, stacked, each
//   fetching its image as it scrolls near.
// - The "Powered by Papermark" badge, floating over the page.
//
// So the number of containers is the page count, in both viewers.
const VIEWER = '.viewer-container';
const ACTIVE_PAGE = '.viewer-container:not(.hidden)';
const PAGE_IMAGE = 'img.viewer-image-mobile';
const NEXT_BUTTON = 'button:has(> svg.lucide-chevron-right)';
const POWERED_BY = 'div.absolute.bottom-0.right-0';
const EMAIL_FIELD = 'input[name="email"]';
const PASSWORD_FIELD = 'input[name="password"]';
const NAME_FIELD = 'input[name="name"]';
const AGREEMENT = '#agreement';
const SUBMIT = 'button[type="submit"]';
const ONE_TIME_CODE = 'input[autocomplete="one-time-code"]';
const BLANK_PAGE = '/_static/blank.gif';

const GATE_TIMEOUT = 15 * SECOND;
const PAGE_TIMEOUT = 15 * SECOND;
/** A backstop on the page loop, far past any real deck. */
const MAX_PAGES = 300;

/** A gate a crawler must not push through, or cannot: a person opens it. */
class PapermarkGateError extends Error {}

/**
 * A Papermark link as a PDF of its pages, one screenshot each, as DocSend's
 * is. Nothing here throws before the screenshots are tried: a page it does
 * not recognise is the AI fallback's (`Crawler.createPdfFromScreenshots`),
 * and a gate it must not answer comes back as an error, since a screenshot of
 * a gate is not a deck.
 */
class PapermarkCrawler extends Crawler {
  /** The view page is a client-rendered app that fetches the document after
   *  it starts, so wait for the gate or the viewer, not for a fixed time. */
  protected async waitUntilReady(): Promise<void> {
    const ready = await pollUntil(this.page, () => anyVisible(this.page, [VIEWER, EMAIL_FIELD, PASSWORD_FIELD, AGREEMENT]), {
      timeout: READY_TIMEOUT,
    });
    if (!ready) {
      logger.info('Papermark showed neither its gate nor its viewer; leaving it to the AI fallback', { url: this.url });
    }
  }

  protected async authenticate(): Promise<Error | null> {
    if (await this.viewerVisible()) return null;

    const email = this.page.locator(EMAIL_FIELD).first();
    const password = this.page.locator(PASSWORD_FIELD).first();
    const submit = this.page.locator(SUBMIT).first();

    const needsEmail = await email.isVisible();
    const needsPassword = await password.isVisible();
    const asksForAgreement = await anyVisible(this.page, [AGREEMENT, NAME_FIELD]);

    if (!needsEmail && !needsPassword && !asksForAgreement) return null;

    // An NDA is a legal agreement made in the firm's name: accepting one is a
    // person's decision, never a crawler's.
    if (asksForAgreement) {
      return new PapermarkGateError('This Papermark link asks the viewer to accept an NDA before showing the deck — open it by hand');
    }

    if (needsEmail) {
      if (!this.email) {
        return new PapermarkGateError(
          'This Papermark link needs an email to view — pass email: to vc_url_retrieval (e.g. email: @user_email)',
        );
      }
      await email.fill(this.email);
    }

    if (needsPassword) {
      if (!this.passcode?.length) {
        return new PapermarkGateError('This Papermark link needs a password to view and none was found near the link');
      }
      await password.fill(this.passcode);
    }

    // Continue enables once every field is valid. Still disabled means the
    // link asks for something more (a custom field); clicking a disabled
    // button would only wait out the click's timeout.
    const enabled = await pollUntil(this.page, async () => (await submit.isVisible()) && (await submit.isEnabled()), {
      timeout: GATE_TIMEOUT,
    });
    if (!enabled) {
      return new PapermarkGateError('This Papermark gate asks for more than an email or password — open it by hand');
    }

    await submit.click();

    const settled = await pollUntil(this.page, () => anyVisible(this.page, [VIEWER, ONE_TIME_CODE]), { timeout: READY_TIMEOUT });
    if (settled && (await this.page.locator(ONE_TIME_CODE).first().isVisible())) {
      return new PapermarkGateError(`This Papermark link emails a one-time code to ${this.email} before it opens — open it by hand`);
    }
    if (!settled) {
      logger.info('Papermark showed no viewer after its gate; leaving it to the AI fallback', { url: this.url });
    }

    return null;
  }

  /** One screenshot per page. None (no viewer it recognises) hands over to
   *  the AI fallback. */
  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    if (!(await this.viewerVisible())) return [];

    await keepHidden(this.page, POWERED_BY);

    const pages = Math.min(await this.page.locator(VIEWER).count(), MAX_PAGES);
    const paginated = (await this.page.locator(`${VIEWER}.hidden`).count()) > 0;

    return paginated ? this.capturePaginated(pages) : this.captureScrollable(pages);
  }

  /** The horizontal viewer: one page shown at a time, "next" to turn it. */
  private async capturePaginated(pages: number): Promise<Screenshot[]> {
    const screenshots: Screenshot[] = [];
    const next = this.page.locator(NEXT_BUTTON).first();

    for (let index = 0; index < pages; index++) {
      const active = this.page.locator(ACTIVE_PAGE).first();
      if (!(await active.isVisible())) break;

      const shot = await this.capturePage(index, active.locator(PAGE_IMAGE).first());
      if (!shot) break;
      screenshots.push(shot);

      if (index === pages - 1 || !(await next.isVisible())) break;

      await next.click();
      await this.page
        .waitForFunction(
          ({ container, turnedTo }) => {
            const shown = document.querySelectorAll(container)[turnedTo];
            return shown !== undefined && !shown.classList.contains('hidden');
          },
          { container: VIEWER, turnedTo: index + 1 },
          { timeout: PAGE_TIMEOUT },
        )
        .catch(() => undefined);
    }

    return screenshots;
  }

  /** The vertical viewer: every page stacked, each fetched as it scrolls near. */
  private async captureScrollable(pages: number): Promise<Screenshot[]> {
    const screenshots: Screenshot[] = [];

    for (let index = 0; index < pages; index++) {
      const container = this.page.locator(VIEWER).nth(index);
      await container.scrollIntoViewIfNeeded().catch(() => undefined);
      const shot = await this.capturePage(index, container.locator(PAGE_IMAGE).first());
      if (!shot) break;
      screenshots.push(shot);
    }

    return screenshots;
  }

  /** The page at `index` once its image has really loaded, not the blank
   *  placeholder shown while it is fetched; null if it never does. */
  private async capturePage(index: number, image: BrowserLocator): Promise<Screenshot | null> {
    const loaded = await this.page
      .waitForFunction(
        ({ container, img, at, blank }) => {
          const el = document.querySelectorAll(container)[at]?.querySelector(img);
          return el instanceof HTMLImageElement && el.complete && el.naturalWidth > 1 && !el.currentSrc.endsWith(blank);
        },
        { container: VIEWER, img: PAGE_IMAGE, at: index, blank: BLANK_PAGE },
        { timeout: PAGE_TIMEOUT },
      )
      .then(
        () => true,
        () => false,
      );
    if (!loaded) {
      logger.info('Papermark page image never loaded; stopping the capture there', { url: this.url, page: index + 1 });
      return null;
    }

    const box = await image.boundingBox();
    if (!box) return null;

    return { width: box.width, height: box.height, data: await image.screenshot() };
  }

  private async viewerVisible(): Promise<boolean> {
    return this.page.locator(VIEWER).first().isVisible();
  }
}

class Papermark {
  /**
   * Get the PDF at the given Papermark URL
   */
  async getAsPdf(
    url: string,
    { email, passcode }: { email?: string; passcode?: string },
  ): Promise<PdfStream | ExternalUrl | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a papermark link.
      const papermarkResult: FetchedDocument<PdfStream> = await readerHost().browser.withPage(
        async (page, browser) => {
          const papermarkCrawler = new PapermarkCrawler({
            page,
            browser,
            url,
            email,
            passcode,
          });
          return papermarkCrawler.getPdf();
        },
        {
          viewport: {
            width: 1100,
            height: 900,
          },
        },
      );

      if (papermarkResult.error) {
        throw papermarkResult.error;
      }

      return papermarkResult.document;
    } catch (err) {
      // Rethrow (rather than swallow to null) so the person who shared the
      // link learns which gate needs them, as BriefLink's and DocSend's do.
      if (err instanceof PapermarkGateError) throw err;

      console.error(err);
      logger.info(`Failed to fetch PDF from papermark link: ${url}.`);

      return null;
    }
  }
}

const PapermarkService = new Papermark();

export { PapermarkService };

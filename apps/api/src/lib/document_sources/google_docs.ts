import { PdfStream } from '.';

import { google } from 'googleapis';

import { getEnvVar } from '../utils/environment';
import { PlaywrightService } from '../../services/playwright';
import { logger } from '../../services/logger';
import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';

class GoogleDocsCrawler extends Crawler {
  protected async takeScreenshotsOfAllPages() {
    // this is based on fullscreen presentation at /mobilepresent
    // if this ever breaks in future, consider trying strategy from commit: e4e132c2f8

    const slideLocators = this.page.locator('.punch-viewer-content').nth(0);
    const nextButtonLocator = this.page.locator('.punch-viewer-navbar-next').nth(0);
    const footerLocator = this.page.locator('.punch-viewer-navbar').nth(0);

    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(1000);

    await footerLocator.evaluate((el) =>
      el.setAttribute('style', 'opacity: 1; pointer-events: auto;'),
    );

    while (true /* eslint-disable-line no-constant-condition */) {
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(200);
      const box = await slideLocators.boundingBox();
      if (box) {
        const screenshot = await slideLocators.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      if ((await nextButtonLocator.getAttribute('aria-disabled')) === 'true') {
        break;
      }

      await nextButtonLocator.waitFor({ state: 'visible' });
      await nextButtonLocator.click();

      // it's a little tricky to confirm that the effects of clicking the button
      // have taken effect, so wait briefly to increase the chance of the render completing.
      await new Promise((resolve) => setTimeout(resolve, 500)); // eslint-disable-line @typescript-eslint/no-loop-func
    }

    return screenshots;
  }
}

// NOTE: this doesn't work in production because either
// - it needs beefier hardware
// - Google have something smart preventing scraping
class GoogleDriveCrawler extends Crawler {
  protected async takeScreenshotsOfAllPages() {
    const pageNumberController = this.page.locator('input[aria-label^="Page is"]');
    let pageNumber = 1;

    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(1000);
    await this.page.waitForLoadState('domcontentloaded');

    while (true /* eslint-disable-line no-constant-condition */) {
      await pageNumberController.fill(String(pageNumber));
      await pageNumberController.press('Enter');

      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(200);
      const slideLocator = await this.page.locator(`img[alt^="Page ${pageNumber} of "]`).nth(0);
      await slideLocator.scrollIntoViewIfNeeded({ timeout: 60000 });
      const box = await slideLocator.boundingBox({ timeout: 60000 });
      if (box) {
        const screenshot = await slideLocator.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      const alt = await slideLocator.getAttribute('alt');
      if (!alt) {
        throw new Error('Expected alt attribute to be present');
      }

      // if the current page is the last page, we're done
      if (/^Page (\d+) of \1$$/.test(alt)) {
        break;
      }

      pageNumber++;
      // it's a little tricky to confirm that the effects of clicking the button
      // have taken effect, so wait briefly to increase the chance of the render completing.
      await new Promise((resolve) => setTimeout(resolve, 500)); // eslint-disable-line @typescript-eslint/no-loop-func
    }

    return screenshots;
  }
}

class GoogleDocs {
  private GDRIVE_FILE_ID_REGEX = /(?<=\/d\/(?!e\/)|\/e\/)[^/]*/;

  getFileId(url: URL) {
    const match = url.pathname.match(this.GDRIVE_FILE_ID_REGEX);
    return url.searchParams.get('id') ?? (match ? match[0] : undefined);
  }

  getFirstPageUrl(url: string) {
    const parsedUrl = new URL(url);
    const searchParamKeys = [...parsedUrl.searchParams.keys()];
    for (const key of searchParamKeys) {
      parsedUrl.searchParams.delete(key);
    }

    // in google docs presentation, load fullscreen presentation at /mobilepresent
    if (parsedUrl.pathname.includes('presentation')) {
      const pathname = parsedUrl.pathname;
      const pathnameEdited = pathname.replace(/\/edit(.*)/, '/mobilepresent');
      parsedUrl.pathname = pathnameEdited;
    }

    return parsedUrl.toString();
  }

  async getAsPdf(url: string): Promise<PdfStream | null> {
    try {
      const fileId = this.getFileId(new URL(url));
      if (fileId) {
        const output = await this.getFromDrive(fileId);
        return output;
      } else {
        return await this.getFromCrawler(url);
      }
    } catch (err) {
      console.error(err);
      return this.getFromCrawler(url);
    }
  }

  async getFromCrawler(url: string) {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a figma link.
      const result: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          let crawler;
          if (/drive\.google\.com/.test(url)) {
            crawler = new GoogleDriveCrawler({
              page,
              browser,
              url: this.getFirstPageUrl(url),
            });
          } else {
            crawler = new GoogleDocsCrawler({
              page,
              browser,
              url: this.getFirstPageUrl(url),
            });
          }
          return crawler.getPdf();
        },
      );

      if (result.error) {
        throw result.error;
      }

      return result.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from Google Docs link: ${url}.`);

      return null;
    }
  }

  async getFromDrive(fileId: string): Promise<PdfStream> {
    const service = google.drive({
      version: 'v3',
      auth: getEnvVar('GOOGLE_DRIVE_API_KEY', { devDefault: 'local' }),
    });

    const metadata = await service.files.get({
      fileId,
      fields: 'name,mimeType',
      supportsAllDrives: true,
    });
    let name = metadata.data.name ?? `${fileId}.pdf`;
    let response;

    if (metadata.data.mimeType?.startsWith('application/vnd.google-apps.')) {
      response = await service.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'stream' },
      );

      if (!name.endsWith('.pdf')) {
        name += '.pdf';
      }
    } else {
      response = await service.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' },
      );

      if (
        metadata.data.mimeType ===
          'application/vnd.openxmlformats-officedocument.presentationml.presentation' &&
        !name.endsWith('.pptx')
      ) {
        name += '.pptx';
      }
    }

    return { type: 'PDF_STREAM', data: response.data, name };
  }
}

const GoogleDocsService = new GoogleDocs();

export { GoogleDocsService };

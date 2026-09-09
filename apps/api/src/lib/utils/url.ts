type ToUrlOpts =
  | {
      log?: boolean;
      lowerCase?: boolean;
    }
  | undefined;

function safeToUrl(url: string, opts?: ToUrlOpts): URL | null {
  const { log = true, lowerCase = false } = opts ?? {};

  const trimmedUrl = url.trim();
  const preparedUrl = lowerCase ? trimmedUrl.toLowerCase() : trimmedUrl;
  for (const candidate of [preparedUrl, `https://${preparedUrl}`]) {
    try {
      return new URL(candidate);
    } catch (err) {
      if (log) console.error(err);
    }
  }

  return null;
}

function toUrl(url: string, opts?: ToUrlOpts): URL {
  const parsedUrl = safeToUrl(url, opts);
  if (!parsedUrl) {
    throw new Error(`Could not make a URL from "${url}"`);
  }

  return parsedUrl;
}

const NON_HTML_PATH_PATTERN = /\.(?:pdf|png|jpe?g|gif|webp|svg|zip|mp4|docx?|xlsx?|pptx?)$/i;

/** Whether the address itself says the target is a file rather than a page.
 *  Cheaper than learning it from the response, and the only way to learn it
 *  without paying for the fetch — which is why it is shared: the scraper
 *  declines to fetch one, and the research plugin declines to queue one. */
function looksLikeNonHtmlAddress(url: string): boolean {
  try {
    return NON_HTML_PATH_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export { toUrl, safeToUrl, looksLikeNonHtmlAddress };

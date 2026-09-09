import { google } from '@google-cloud/documentai/build/protos/protos';

import { OCR_START_PAGE_TAG } from '../../constants';

function extractConcatenatedPages(
  document?: google.cloud.documentai.v1.IDocument | null,
): string | null {
  if (!document || !document.text || !document.pages?.length) {
    return null;
  }

  let text = '';
  for (const page of document.pages) {
    const pageContent = extractPage(page, document.text);
    if (pageContent) {
      text += `${OCR_START_PAGE_TAG}\n${pageContent}`;
    }
  }

  return text === '' ? null : text;
}

function extractPage(
  page: google.cloud.documentai.v1.Document.IPage,
  fulltext: string,
): string | null {
  const paragraphs = page?.paragraphs;
  const numParagraphs = paragraphs?.length;
  if (!paragraphs || !numParagraphs) {
    return null;
  }

  const startAnchor = paragraphs[0].layout?.textAnchor;
  const endAnchor = paragraphs[numParagraphs - 1].layout?.textAnchor;
  if (!startAnchor || !endAnchor) {
    return null;
  }

  const startIndex = getStartIndex(startAnchor) ?? 0; // First shard in document doesn't have startIndex property
  const endIndex = getEndIndex(endAnchor);

  return endIndex ? fulltext.substring(startIndex, endIndex) : null;
}

function getStartIndex(anchor: google.cloud.documentai.v1.Document.ITextAnchor): number | null {
  return !anchor.textSegments || !anchor.textSegments[0].startIndex
    ? null
    : Number(anchor.textSegments[0].startIndex);
}

function getEndIndex(anchor: google.cloud.documentai.v1.Document.ITextAnchor): number | null {
  return !anchor.textSegments || !anchor.textSegments[anchor.textSegments.length - 1].endIndex
    ? null
    : Number(anchor.textSegments[anchor.textSegments.length - 1].endIndex);
}

export { extractConcatenatedPages };

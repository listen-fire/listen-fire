import { Readable } from 'node:stream';

import { streamToBuffer } from '../utils/stream';
import { extractConcatenatedPages } from './page';
import { getProcessorName, googleOcrClient } from './google';

/** Up to 15 pages or 20MB */
async function ocrOnline(rs: Readable) {
  const buffered = await streamToBuffer(rs);
  const [result] = await googleOcrClient.processDocument({
    name: getProcessorName(),
    rawDocument: {
      content: buffered.toString('base64'),
      mimeType: 'application/pdf',
    },
  });

  return extractConcatenatedPages(result.document);
}

export { ocrOnline };

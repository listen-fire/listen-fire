import { Readable } from 'node:stream';

import { MB } from '../../constants';
import { ocrOnline } from './online';
import { ocrInBatch } from './batched';
import { streamToBuffer } from '../utils/stream';

async function extractPdf(rs: Readable, { numpages, size }: { numpages?: number; size: number }) {
  // Quota limits https://cloud.google.com/document-ai/quotas
  return extractPdfFromBuffer(await streamToBuffer(rs), { numpages, size });
}

async function extractPdfFromBuffer(
  buffer: Buffer,
  { numpages, size }: { numpages?: number; size: number },
) {
  const rs = Readable.from(buffer);
  if (numpages && numpages <= 15 && size < 20 * MB) {
    return ocrOnline(rs);
  } else {
    return ocrInBatch(rs);
  }
}

export { extractPdf };

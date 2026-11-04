import { Readable } from 'node:stream';

import { bufferStreamCapped, MB, type FileTextLogger, type FileUnreadable } from './shared';

/** The OCR provider for an image, injected. A shell that passes none leaves
 *  images `unsupported_type`. */
export type OcrImage = (
  stream: Readable,
  options: { size: number; mimeType: ImageType },
) => Promise<string | FileUnreadable | null>;

// The list the standalone runner and the ocr slot's contract read
// (`crates/lf/src/ocr.rs`, docs/contracts/ocr-slot.md). SVG is left out: it is
// text describing a picture, and no OCR provider reads it.
const IMAGE_TYPES = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/tiff': ['.tif', '.tiff'],
  'image/bmp': ['.bmp'],
  'image/webp': ['.webp'],
} as const satisfies Record<string, readonly string[]>;

export type ImageType = keyof typeof IMAGE_TYPES;

const isImageType = (type: string): type is ImageType => Object.hasOwn(IMAGE_TYPES, type);

const imageTypes = (): ImageType[] => Object.keys(IMAGE_TYPES).filter(isImageType);

/** The image type a file is, by its content type or else its extension. */
export function imageType(file: { name?: string; contentType?: string }): ImageType | undefined {
  const type = (file.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (isImageType(type)) return type;
  const name = (file.name ?? '').toLowerCase();
  return imageTypes().find((candidate) => IMAGE_TYPES[candidate].some((extension) => name.endsWith(extension)));
}

/** The stream has to be held to learn its size, which decides how a provider
 *  reads it, so an image is capped as a PDF's text layer read is. */
function maxImageBytes(): number {
  const fromEnv = Number(process.env.MAX_IMAGE_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 64 * MB;
}

/**
 * An image: there is no text of its own to read, so it is the OCR provider's.
 * A failure says the file went to OCR, as a scanned PDF's does, because the
 * provider's message alone sends the reader after the wrong thing.
 */
export async function extractImageText(
  stream: Readable,
  file: { name?: string; mimeType: ImageType },
  deps: { ocrImage: OcrImage; isRefusal?(error: unknown): boolean; logger: FileTextLogger },
): Promise<string | FileUnreadable | null> {
  const cap = maxImageBytes();
  const bytes = await bufferStreamCapped(stream, cap);
  if (bytes === null) {
    deps.logger.warn('[movement:file-text] image too large to read — skipping', { name: file.name, cap });
    return { unreadable: 'extraction_failed', detail: `the image is larger than the ${cap}-byte limit for reading an image` };
  }
  try {
    return await deps.ocrImage(Readable.from(bytes), { size: bytes.length, mimeType: file.mimeType });
  } catch (error) {
    if (deps.isRefusal?.(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`an image is read by OCR; ${message}`, { cause: error });
  }
}

// The package on its own: fixture files read to the exact text the product
// produced before the move (the goldens below were taken from the pre-move
// code), and the resolver's rules with every dependency injected. unpdf is ESM
// and jest's CJS vm cannot load it, so the PDF parser is mocked here; the real
// parse was compared against the pre-move text under plain node.

const extractTextMock = jest.fn();
jest.mock('unpdf', () => ({ extractText: (...args: unknown[]) => extractTextMock(...args) }));

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { getPptxText, getXlsxContent, makeFileTextResolver, type FileDescriptor } from '../index';

const FIXTURES = path.join(__dirname, '__fixtures__');
const fixture = (name: string) => createReadStream(path.join(FIXTURES, name));

const logger = { debug: jest.fn(), warn: jest.fn() };

function resolver(overrides: Partial<Parameters<typeof makeFileTextResolver<FileDescriptor>>[0]> = {}) {
  return makeFileTextResolver<FileDescriptor>({
    openBytes: async () => ({ stream: Readable.from([Buffer.from('bytes')]), size: 5 }),
    ocrPdf: jest.fn().mockResolvedValue('ocr text'),
    transcribe: jest.fn().mockResolvedValue({ text: 'spoken words' }),
    analyzeSheet: jest.fn(),
    rawText: { getOrCreateId: async () => 'rt-1' },
    logger,
    ...overrides,
  });
}

describe('fixtures read to the text they always did', () => {
  it('a deck: pages in numeric order, paragraphs on their own lines', async () => {
    expect(await getPptxText(fixture('deck.pptx'))).toBe(
      '--- Page 1 ---\n\n\nAcme Robotics\nSeed round, 2026\n\n--- Page 2 ---\n\n\nTraction\n120 customers\nRevenue up 4x\n\n--- Page 10 ---\n\n\nAppendix',
    );
  });

  it('a CSV: the sheet model answers the layout, formulas stay as written', async () => {
    const analyzeSheet = jest
      .fn()
      .mockResolvedValue(
        '[{"type":"header","startRow":0,"endRow":0},{"type":"table","startRow":0,"endRow":2,"startCol":0,"endCol":3,"hasHeader":true}]',
      );
    expect(await getXlsxContent(fixture('sheet.csv'), 'sheet.csv', analyzeSheet)).toBe(
      '# sheet1\n\n## Name Q1 Q2 Total\n\n```json\n[\n  {\n    "Name": "Alpha",\n    "Q1": 10,\n    "Q2": 20,\n    "Total": "=B2+C2"\n  },\n  {\n    "Name": "Beta",\n    "Q1": 5,\n    "Q2": 7,\n    "Total": "=B3+C3"\n  }\n]\n```\n',
    );
    expect(analyzeSheet).toHaveBeenCalledTimes(1);
  });
});

describe('the resolver', () => {
  it('refuses an unsupported type with its content type as the detail', async () => {
    expect(await resolver()({ file: { name: 'x.zip', contentType: 'application/zip' } })).toEqual({
      unreadable: 'unsupported_type',
      detail: 'application/zip',
    });
  });

  it('says the bytes were unavailable, but lets a refusal propagate', async () => {
    const boom = new Error('gone');
    expect(
      await resolver({ openBytes: async () => { throw boom; } })({ file: { name: 'a.pdf' } }),
    ).toEqual({ unreadable: 'bytes_unavailable', detail: 'gone' });
    const refusal = new Error('not yours');
    await expect(
      resolver({ openBytes: async () => { throw refusal; }, isRefusal: (e) => e === refusal })({
        file: { name: 'a.pdf' },
      }),
    ).rejects.toBe(refusal);
  });

  it('reads the PDF text layer without calling OCR', async () => {
    extractTextMock.mockResolvedValue({ text: 'x'.repeat(200), totalPages: 1 });
    const ocrPdf = jest.fn();
    const result = await resolver({ ocrPdf })({ file: { name: 'a.pdf' } });
    expect(result).toEqual({ text: 'x'.repeat(200), rawTextId: 'rt-1' });
    expect(ocrPdf).not.toHaveBeenCalled();
  });

  it('falls through to OCR on a scan, and names both halves when OCR fails', async () => {
    extractTextMock.mockResolvedValue({ text: '1 2 3', totalPages: 3 });
    const ocrPdf = jest.fn().mockResolvedValue('scanned words');
    expect(await resolver({ ocrPdf })({ file: { name: 'a.pdf' } })).toEqual({
      text: 'scanned words',
      rawTextId: 'rt-1',
    });
    const failing = jest.fn().mockRejectedValue(new Error('OCR is not configured'));
    expect(await resolver({ ocrPdf: failing })({ file: { name: 'a.pdf' } })).toEqual({
      unreadable: 'extraction_failed',
      detail: 'no text layer; OCR is not configured',
    });
  });

  it('transcribes audio, and scrubs NUL from any text', async () => {
    const transcribe = jest.fn().mockResolvedValue({ text: 'a\u0000b' });
    expect(await resolver({ transcribe })({ file: { name: 'v.ogg' } })).toEqual({
      text: 'a b',
      rawTextId: 'rt-1',
    });
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'v.ogg', audio: Buffer.from('bytes') }),
    );
  });

  describe('an image', () => {
    const png = Buffer.from('png bytes');
    const opened = async () => ({ stream: Readable.from([png]), size: png.length });

    it.each([
      ['image/png', 'x.bin', 'image/png'],
      ['image/jpeg; charset=binary', 'x', 'image/jpeg'],
      ['IMAGE/GIF', 'x', 'image/gif'],
      ['image/tiff', 'x', 'image/tiff'],
      ['image/bmp', 'x', 'image/bmp'],
      ['image/webp', 'x', 'image/webp'],
      [undefined, 'photo.JPG', 'image/jpeg'],
      [undefined, 'scan.tif', 'image/tiff'],
      ['application/octet-stream', 'shot.png', 'image/png'],
    ])('type %s named %s goes to OCR as %s', async (contentType, name, mimeType) => {
      const ocrImage = jest.fn(async (_stream: Readable, _options: { size: number; mimeType: string }) => 'the words on it');
      const read = resolver({ openBytes: opened, ocrImage });
      expect(await read({ file: { name, contentType } })).toEqual({ text: 'the words on it', rawTextId: 'rt-1' });
      expect(ocrImage).toHaveBeenCalledWith(expect.any(Readable), { size: png.length, mimeType });
    });

    it('hands OCR the bytes whole', async () => {
      let seen: Buffer | undefined;
      const read = resolver({
        openBytes: opened,
        ocrImage: async (stream) => {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          seen = Buffer.concat(chunks);
          return 'text';
        },
      });
      await read({ file: { contentType: 'image/png' } });
      expect(seen).toEqual(png);
    });

    it('never reads an SVG, which is no picture of text', async () => {
      const ocrImage = jest.fn();
      const openBytes = jest.fn(opened);
      expect(await resolver({ openBytes, ocrImage })({ file: { name: 'logo.svg', contentType: 'image/svg+xml' } })).toEqual({
        unreadable: 'unsupported_type',
        detail: 'image/svg+xml',
      });
      expect(ocrImage).not.toHaveBeenCalled();
      expect(openBytes).not.toHaveBeenCalled();
    });

    it('keeps an image unsupported for a shell that names no image reader, and spends nothing opening it', async () => {
      const openBytes = jest.fn(opened);
      expect(await resolver({ openBytes })({ file: { name: 'a.png', contentType: 'image/png' } })).toEqual({
        unreadable: 'unsupported_type',
        detail: 'image/png',
      });
      expect(openBytes).not.toHaveBeenCalled();
    });

    it.each([[null], [''], ['  \n ']])('with no text on it (%j) is no_text', async (answer) => {
      const read = resolver({ openBytes: opened, ocrImage: async () => answer });
      expect(await read({ file: { contentType: 'image/png' } })).toEqual({ unreadable: 'no_text' });
    });

    it('says it went to OCR when OCR fails', async () => {
      const read = resolver({
        openBytes: opened,
        ocrImage: async () => {
          throw new Error('OCR is not configured');
        },
      });
      expect(await read({ file: { contentType: 'image/png' } })).toEqual({
        unreadable: 'extraction_failed',
        detail: 'an image is read by OCR; OCR is not configured',
      });
    });

    it('lets a refusal through, however deep it was raised', async () => {
      class PastBudget extends Error {}
      const read = resolver({
        openBytes: opened,
        isRefusal: (error) => error instanceof PastBudget,
        ocrImage: async () => {
          throw new PastBudget('spent');
        },
      });
      await expect(read({ file: { contentType: 'image/png' } })).rejects.toBeInstanceOf(PastBudget);
    });

    it('is refused whole past the cap, and costs no OCR', async () => {
      process.env.MAX_IMAGE_BYTES = '4';
      const ocrImage = jest.fn();
      try {
        expect(await resolver({ openBytes: opened, ocrImage })({ file: { contentType: 'image/png' } })).toEqual({
          unreadable: 'extraction_failed',
          detail: 'the image is larger than the 4-byte limit for reading an image',
        });
      } finally {
        delete process.env.MAX_IMAGE_BYTES;
      }
      expect(ocrImage).not.toHaveBeenCalled();
    });
  });

  it('still answers with the text when the raw-text store fails', async () => {
    const rawText = { getOrCreateId: async () => { throw new Error('db down'); } };
    expect(await resolver({ rawText })({ file: { name: 'v.ogg' } })).toEqual({ text: 'spoken words' });
  });
});

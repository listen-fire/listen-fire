// The FileRef → text seam's AUDIO kind: classification, transcription via
// services.transcription, the duration-based meter report, and the size guard.
// streamFileRef + RawTextService are mocked — this suite proves file_text.ts
// itself (the other kinds are covered one level up in extraction-file tests).

const streamFileRefMock = jest.fn();
jest.mock('../../translation_graph/engine/files/retrieve', () => ({
  streamFileRef: (...args: unknown[]) => streamFileRefMock(...args),
}));

const getOrCreateRawTextIdMock = jest.fn();
jest.mock('../raw_text_store', () => ({
  getOrCreateRawTextId: (...args: unknown[]) => getOrCreateRawTextIdMock(...args),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Readable } from 'node:stream';

import { makeFileTextResolver } from '../file_text';
import { services } from '../../../adapters/registry';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { logger } from '../../logger';
import type { FileRef } from '../../translation_graph/adapter';
import type { TranscriptionAdapter } from '../../../adapters/transcription/interface';

const transcribeMock = jest.fn();
const ocrMock = jest.fn();

function audioRef(overrides: Partial<{ name: string; contentType: string; size: number }> = {}): FileRef {
  return {
    __brand: 'FileRef',
    name: overrides.name ?? 'voice.ogg',
    contentType: overrides.contentType === '' ? undefined : (overrides.contentType ?? 'audio/ogg'),
    size: overrides.size,
    source: { ownerAdapterType: 'telegram', handle: 'file-1' },
  };
}

function resolvedAudio(bytes = 'fake-audio-bytes') {
  return { stream: Readable.from([Buffer.from(bytes)]), contentType: 'audio/ogg', size: bytes.length };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MAX_TRANSCRIPTION_BYTES;
  services.transcription = { transcribe: transcribeMock } as TranscriptionAdapter;
  services.ocr = { extractPdf: ocrMock };
  streamFileRefMock.mockResolvedValue(resolvedAudio());
  transcribeMock.mockResolvedValue({ text: 'hello from the voice note', durationSeconds: 2.4 });
  getOrCreateRawTextIdMock.mockResolvedValue('rt-audio-1');
});

describe('audio classification → transcription → raw text', () => {
  it.each([
    ['content type audio/ogg', { contentType: 'audio/ogg', name: 'x.bin' }],
    ['opus voice-note content type', { contentType: 'audio/ogg; codecs=opus', name: 'x' }],
    ['audio/mp4 (whatsapp/telegram audio)', { contentType: 'audio/mp4', name: 'x' }],
    ['.m4a extension only', { contentType: '', name: 'memo.m4a' }],
    ['.mp3 extension only', { contentType: '', name: 'song.mp3' }],
    ['.wav extension only', { contentType: '', name: 'clip.wav' }],
    ['.opus extension only', { contentType: '', name: 'note.opus' }],
    ['.webm extension only', { contentType: '', name: 'rec.webm' }],
  ])('transcribes when classified by %s', async (_label, over) => {
    const resolve = makeFileTextResolver();
    const result = await resolve(audioRef(over));
    expect(transcribeMock).toHaveBeenCalledWith(expect.any(Buffer), {
      name: over.name,
      contentType: over.contentType || undefined,
    });
    expect(getOrCreateRawTextIdMock).toHaveBeenCalledWith('hello from the voice note');
    expect(result).toEqual({ text: 'hello from the voice note', rawTextId: 'rt-audio-1' });
  });

  it('hands the resolved bytes to the transcriber', async () => {
    const resolve = makeFileTextResolver();
    await resolve(audioRef());
    const buffer = transcribeMock.mock.calls[0][0] as Buffer;
    expect(buffer.toString()).toBe('fake-audio-bytes');
  });

  it('returns null for an empty transcript', async () => {
    transcribeMock.mockResolvedValue(null);
    const resolve = makeFileTextResolver();
    const result = await new LlmUsageContext({ teamId: 'team-1' }).runAsync(async () =>
      resolve(audioRef()),
    );
    expect(result).toBeNull();
    expect(getOrCreateRawTextIdMock).not.toHaveBeenCalled();
  });
});

describe('the size guard — no silent truncation', () => {
  it('skips (loudly) when the declared size exceeds the cap', async () => {
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('bytes')]) });
    const resolve = makeFileTextResolver();
    const result = await resolve(audioRef({ size: 25 * 1024 * 1024 }));
    expect(result).toBeNull();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('audio too large'),
      expect.objectContaining({ name: 'voice.ogg' }),
    );
  });

  it('aborts (loudly) when an undeclared-size stream overruns the cap', async () => {
    process.env.MAX_TRANSCRIPTION_BYTES = '8';
    streamFileRefMock.mockResolvedValue({
      stream: Readable.from([Buffer.from('way-more-than-eight-bytes')]),
    });
    const resolve = makeFileTextResolver();
    const result = await resolve(audioRef({ size: undefined }));
    expect(result).toBeNull();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('audio too large'),
      expect.objectContaining({ name: 'voice.ogg' }),
    );
  });
});

describe('the existing kinds are untouched', () => {
  it('a PDF still routes to services.ocr', async () => {
    ocrMock.mockResolvedValue('pdf text');
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    getOrCreateRawTextIdMock.mockResolvedValue('rt-pdf');
    const resolve = makeFileTextResolver();
    const result = await resolve({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { ownerAdapterType: 'email', handle: 'a-1' },
    });
    expect(ocrMock).toHaveBeenCalled();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'pdf text', rawTextId: 'rt-pdf' });
  });

  it('an unknown binary type is still skipped', async () => {
    const resolve = makeFileTextResolver();
    const result = await resolve({
      __brand: 'FileRef',
      name: 'archive.zip',
      contentType: 'application/zip',
      source: { ownerAdapterType: 'email', handle: 'a-2' },
    });
    expect(result).toBeNull();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(ocrMock).not.toHaveBeenCalled();
  });
});

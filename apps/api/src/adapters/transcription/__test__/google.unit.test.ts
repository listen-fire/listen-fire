// Speech to text on the Google route: which format is accepted, which is
// refused by name, and how big a file may be before it is refused by size.

const geminiTranscribe = jest.fn();
jest.mock('../../../lib/gemini', () => ({
  ...jest.requireActual('../../../lib/gemini'),
  geminiTranscribe: (...args: unknown[]) => geminiTranscribe(...args),
}));

import { GoogleTranscriptionAdapter } from '../google';
import { geminiAudioMimeType } from '../audio_format';

/** An Ogg container's first four bytes are the whole claim. */
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
const M4A = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(64)]);
const NOT_AUDIO = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]);

beforeEach(() => {
  geminiTranscribe.mockReset().mockResolvedValue({ text: 'the words that were said' });
});

describe('naming the format Gemini is given', () => {
  it('believes the bytes over the declared content type', () => {
    // WhatsApp calls an Ogg/Opus voice note `audio/mpeg` often enough to matter.
    expect(geminiAudioMimeType(OGG, { contentType: 'audio/mpeg' })).toBe('audio/ogg');
  });

  it('spells each container the way Gemini does', () => {
    expect(geminiAudioMimeType(WAV, {})).toBe('audio/wav');
    expect(geminiAudioMimeType(M4A, {})).toBe('audio/m4a');
    expect(geminiAudioMimeType(OGG, {})).toBe('audio/ogg');
  });

  it('falls back to the content type when the bytes say nothing', () => {
    // Opus rides in an Ogg container, and AAC is `audio/x-aac` to Gemini.
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/ogg; codecs=opus' })).toBe('audio/ogg');
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/aac' })).toBe('audio/x-aac');
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/x-m4a' })).toBe('audio/m4a');
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/webm' })).toBe('audio/webm');
  });

  it('knows nothing about a format Gemini does not serve', () => {
    // `audio/aiff` is absent from Gemini's own list, so it is a no rather than
    // a guess.
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/aiff' })).toBeUndefined();
    expect(geminiAudioMimeType(NOT_AUDIO, {})).toBeUndefined();
  });
});

describe('the adapter', () => {
  it('transcribes and returns only the text', async () => {
    const result = await new GoogleTranscriptionAdapter().transcribe(OGG, { name: 'note.ogg' });
    expect(result).toEqual({ text: 'the words that were said' });
    expect(geminiTranscribe).toHaveBeenCalledWith(OGG, expect.objectContaining({ mimeType: 'audio/ogg' }));
  });

  it('reports nothing said as nothing, not as an empty transcript', async () => {
    geminiTranscribe.mockResolvedValue({ text: '   ' });
    await expect(new GoogleTranscriptionAdapter().transcribe(OGG, {})).resolves.toBeNull();
  });

  it('refuses a format by name rather than sending it and hoping', async () => {
    await expect(
      new GoogleTranscriptionAdapter().transcribe(NOT_AUDIO, {
        name: 'recording.aiff',
        contentType: 'audio/aiff',
      }),
    ).rejects.toThrow(/does not accept this audio format.*audio\/aiff/s);
    expect(geminiTranscribe).not.toHaveBeenCalled();
  });
});

describe('the size a request may carry', () => {
  it('names the limit rather than letting Google discover it', async () => {
    const { geminiTranscribe: real, GEMINI_INLINE_AUDIO_MAX_BYTES } =
      jest.requireActual('../../../lib/gemini');
    const tooBig = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(GEMINI_INLINE_AUDIO_MAX_BYTES)]);
    await expect(real(tooBig, { mimeType: 'audio/ogg' })).rejects.toThrow(
      new RegExp(`over the ${GEMINI_INLINE_AUDIO_MAX_BYTES}-byte limit`),
    );
  });
});

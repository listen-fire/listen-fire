import { OpenAiTranscriptionAdapter } from '../openai';

const transcribeMock = jest.fn();
jest.mock('../../../lib/openai', () => ({
  openAiTranscribe: (...args: unknown[]) => transcribeMock(...args),
}));

describe('OpenAiTranscriptionAdapter', () => {
  beforeEach(() => transcribeMock.mockReset());

  it('maps the transcription helper result onto TranscriptionResult', async () => {
    transcribeMock.mockResolvedValue({ text: 'hello world', duration: 2.4 });
    const adapter = new OpenAiTranscriptionAdapter();
    const result = await adapter.transcribe(Buffer.from('fake-audio-bytes'), {
      name: 'voice.ogg',
      contentType: 'audio/ogg',
    });
    expect(result).toEqual({ text: 'hello world', durationSeconds: 2.4 });
    expect(transcribeMock).toHaveBeenCalledWith(expect.any(Buffer), {
      name: 'voice.ogg',
      label: 'file_transcription',
    });
  });

  it('defaults the upload name (with a format extension) when the file has none', async () => {
    transcribeMock.mockResolvedValue({ text: 'ok', duration: 1 });
    const adapter = new OpenAiTranscriptionAdapter();
    await adapter.transcribe(Buffer.from('bytes'), {});
    expect(transcribeMock).toHaveBeenCalledWith(expect.any(Buffer), {
      name: 'audio.ogg',
      label: 'file_transcription',
    });
  });

  it('returns null for a blank transcript', async () => {
    transcribeMock.mockResolvedValue({ text: '   ', duration: 3 });
    const adapter = new OpenAiTranscriptionAdapter();
    expect(await adapter.transcribe(Buffer.from('bytes'), { name: 'a.mp3' })).toBeNull();
  });

  it('returns null when the helper yields nothing', async () => {
    transcribeMock.mockResolvedValue(null);
    const adapter = new OpenAiTranscriptionAdapter();
    expect(await adapter.transcribe(Buffer.from('bytes'), { name: 'a.mp3' })).toBeNull();
  });
});

describe('upload naming — OpenAI infers format from the filename extension', () => {
  const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]);
  const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
  const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
  const M4A = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]);
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
  const FLAC = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)]);
  const UNKNOWN = Buffer.alloc(20);

  beforeEach(() => transcribeMock.mockResolvedValue({ text: 'ok', duration: 1 }));

  async function uploadedName(audio: Buffer, options: { name?: string; contentType?: string }) {
    await new OpenAiTranscriptionAdapter().transcribe(audio, options);
    return (transcribeMock.mock.calls[0][1] as { name: string }).name;
  }

  it('appends the sniffed extension when the name has none (the WhatsApp voice-note case)', async () => {
    expect(await uploadedName(OGG, { name: 'wamid.HBgMNDQ3', contentType: 'audio/ogg; codecs=opus' })).toBe(
      'wamid.HBgMNDQ3.ogg',
    );
  });

  it.each([
    ['mp3 (ID3)', MP3_ID3, 'mp3'],
    ['wav (RIFF/WAVE)', WAV, 'wav'],
    ['m4a (ftyp)', M4A, 'm4a'],
    ['webm (EBML)', WEBM, 'webm'],
    ['flac', FLAC, 'flac'],
  ])('sniffs %s from the bytes', async (_label, bytes, ext) => {
    expect(await uploadedName(bytes, { name: 'nameless' })).toBe(`nameless.${ext}`);
  });

  it('keeps a name that already carries a supported extension', async () => {
    expect(await uploadedName(OGG, { name: 'note.mp3' })).toBe('note.mp3');
  });

  it('falls back to the content type when the bytes are unrecognised', async () => {
    expect(await uploadedName(UNKNOWN, { name: 'blob', contentType: 'audio/mpeg' })).toBe('blob.mp3');
  });

  it('defaults sensibly when neither bytes nor content type identify the format', async () => {
    expect(await uploadedName(UNKNOWN, { name: 'blob' })).toBe('blob.ogg');
  });
});

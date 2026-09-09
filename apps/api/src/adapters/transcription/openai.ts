import { openAiTranscribe } from '../../lib/openai';
import { TranscriptionAdapter, TranscriptionResult } from './interface';

// OpenAI's transcription endpoint infers the audio FORMAT from the uploaded
// filename's extension and 400s on anything outside this set — a channel that
// delivers nameless audio (a WhatsApp voice note's name falls back to the
// message id) needs the extension derived, not trusted.
const SUPPORTED_EXTENSIONS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

/** Sniff the container format from its magic bytes — the bytes are the truth
 *  the filename and content type only gesture at. */
function sniffExtension(audio: Buffer): string | undefined {
  if (audio.length < 12) return undefined;
  if (audio.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (audio.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (
    audio.subarray(0, 4).toString('latin1') === 'RIFF' &&
    audio.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'wav';
  }
  if (audio.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (audio.readUInt32BE(0) === 0x1a45dfa3) return 'webm'; // EBML (webm/mkv)
  if (audio.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  return undefined;
}

const EXTENSION_BY_CONTENT_TYPE: Array<[string, string]> = [
  ['audio/ogg', 'ogg'],
  ['audio/opus', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/aac', 'm4a'], // AAC usually arrives in an MP4 container in practice
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/webm', 'webm'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
];

function extensionFromContentType(contentType?: string): string | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.toLowerCase();
  return EXTENSION_BY_CONTENT_TYPE.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}

/** The multipart filename OpenAI reads the format from: keep a name that
 *  already ends in a supported extension; otherwise append one derived from
 *  the bytes, then the content type, then the ogg default (voice notes are
 *  the overwhelmingly common nameless case). */
function uploadName(audio: Buffer, options: { name?: string; contentType?: string }): string {
  const name = options.name ?? 'audio';
  const lower = name.toLowerCase();
  if (SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`))) return name;
  const extension = sniffExtension(audio) ?? extensionFromContentType(options.contentType) ?? 'ogg';
  return `${name}.${extension}`;
}

export class OpenAiTranscriptionAdapter implements TranscriptionAdapter {
  async transcribe(
    audio: Buffer,
    options: { name?: string; contentType?: string },
  ): Promise<TranscriptionResult | null> {
    const result = await openAiTranscribe(audio, {
      name: uploadName(audio, options),
      label: 'file_transcription',
    });
    if (!result || result.text.trim().length === 0) return null;
    return { text: result.text, durationSeconds: result.duration };
  }
}

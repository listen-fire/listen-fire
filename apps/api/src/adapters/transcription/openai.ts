import { openAiTranscribe } from '../../lib/openai';
import { sniffContainer } from './audio_format';
import { TranscriptionAdapter, TranscriptionResult } from './interface';

// OpenAI's transcription endpoint infers the audio FORMAT from the uploaded
// filename's extension and 400s on anything outside this set — a channel that
// delivers nameless audio (a WhatsApp voice note's name falls back to the
// message id) needs the extension derived, not trusted.
const SUPPORTED_EXTENSIONS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

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
  const extension = sniffContainer(audio) ?? extensionFromContentType(options.contentType) ?? 'ogg';
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

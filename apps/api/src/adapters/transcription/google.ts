import { geminiTranscribe } from '../../lib/gemini';
import { geminiAudioMimeType } from './audio_format';
import { TranscriptionAdapter, TranscriptionResult } from './interface';

/**
 * Speech to text on the Google route: Gemini, given the audio and asked for the
 * words.
 *
 * A format Gemini does not take fails by name here rather than being sent and
 * hoped for — the endpoint's own refusal names a MIME type nobody upstream ever
 * wrote down, and the useful sentence is which of OUR formats went unserved.
 */
export class GoogleTranscriptionAdapter implements TranscriptionAdapter {
  async transcribe(
    audio: Buffer,
    options: { name?: string; contentType?: string },
  ): Promise<TranscriptionResult | null> {
    const mimeType = geminiAudioMimeType(audio, { contentType: options.contentType });
    if (!mimeType) {
      throw new Error(
        `Gemini does not accept this audio format (name "${options.name ?? 'unnamed'}", ` +
          `content type "${options.contentType ?? 'none'}", and its bytes name no container ` +
          'Gemini serves).',
      );
    }

    const result = await geminiTranscribe(audio, { mimeType, label: 'file_transcription' });
    if (!result || result.text.trim().length === 0) return null;
    // No duration: Gemini answers with words, and nothing downstream reads one.
    return { text: result.text };
  }
}

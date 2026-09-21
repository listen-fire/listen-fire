export interface TranscriptionResult {
  text: string;
  /**
   * Length of the source audio in seconds, where the provider hands it over for
   * free (OpenAI's `verbose_json` does).
   *
   * Optional because NOTHING reads it. It was the metering unit until billing
   * was removed (eb979fb62, 2026-08-27) took its only consumer with it, and an
   * adapter whose provider does not volunteer the number should say so rather
   * than decode the audio to produce a figure no caller asks for.
   */
  durationSeconds?: number;
}

export interface TranscriptionAdapter {
  transcribe(
    audio: Buffer,
    options: { name?: string; contentType?: string },
  ): Promise<TranscriptionResult | null>;
}

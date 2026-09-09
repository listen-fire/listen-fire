export interface TranscriptionResult {
  text: string;
  /** Length of the source audio in seconds — the metering unit. */
  durationSeconds: number;
}

export interface TranscriptionAdapter {
  transcribe(
    audio: Buffer,
    options: { name?: string; contentType?: string },
  ): Promise<TranscriptionResult | null>;
}

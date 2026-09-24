// Who transcribes, per the model map's answer for Whisper.

import { chooseTranscriptionAdapter } from '../choose';
import { GoogleTranscriptionAdapter } from '../google';
import { OpenAiTranscriptionAdapter } from '../openai';

it('transcribes through OpenAI when nothing says otherwise', () => {
  expect(chooseTranscriptionAdapter({})).toBeInstanceOf(OpenAiTranscriptionAdapter);
  expect(chooseTranscriptionAdapter({ MODEL_MAP: '' })).toBeInstanceOf(OpenAiTranscriptionAdapter);
});

it('transcribes through Gemini where the map sends Whisper there', () => {
  expect(
    chooseTranscriptionAdapter({ MODEL_MAP: JSON.stringify({ 'whisper-1': 'gemini/gemini-3.8-flash' }) }),
  ).toBeInstanceOf(GoogleTranscriptionAdapter);
});

it("follows Whisper's own map line rather than Claude's", () => {
  expect(
    chooseTranscriptionAdapter({
      MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
    }),
  ).toBeInstanceOf(OpenAiTranscriptionAdapter);
});

it('refuses a map value nobody serves rather than picking one', () => {
  expect(() =>
    chooseTranscriptionAdapter({ MODEL_MAP: JSON.stringify({ 'whisper-1': 'whisper/whisper-1' }) }),
  ).toThrow(/MODEL_MAP\["whisper-1"\]/);
});

// Who transcribes, per route.

import { chooseTranscriptionAdapter } from '../choose';
import { GoogleTranscriptionAdapter } from '../google';
import { OpenAiTranscriptionAdapter } from '../openai';

const GOOGLE_ENV = {
  MODEL_ROUTE: 'google',
  KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

it('transcribes through OpenAI when nothing says otherwise', () => {
  expect(chooseTranscriptionAdapter({})).toBeInstanceOf(OpenAiTranscriptionAdapter);
  expect(chooseTranscriptionAdapter({ MODEL_ROUTE: 'direct' })).toBeInstanceOf(
    OpenAiTranscriptionAdapter,
  );
});

it('transcribes through Gemini on the google route', () => {
  expect(chooseTranscriptionAdapter(GOOGLE_ENV)).toBeInstanceOf(GoogleTranscriptionAdapter);
});

it('refuses a route nobody serves rather than picking one', () => {
  expect(() => chooseTranscriptionAdapter({ MODEL_ROUTE: 'whisper' })).toThrow(
    /must be "direct" or "google"/,
  );
});

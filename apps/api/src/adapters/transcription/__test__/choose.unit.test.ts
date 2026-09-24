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

it("follows the OpenAI route rather than Claude's", () => {
  // Whisper is an OpenAI model, so a deployment that has moved only its Claude
  // calls to Google still transcribes through OpenAI, and one that has moved
  // only its OpenAI-shaped calls transcribes through Gemini.
  expect(
    chooseTranscriptionAdapter({ MODEL_ROUTE: 'google', ANTHROPIC_MODEL_ROUTE: 'google', OPENAI_MODEL_ROUTE: 'direct' }),
  ).toBeInstanceOf(OpenAiTranscriptionAdapter);
  expect(chooseTranscriptionAdapter({ OPENAI_MODEL_ROUTE: 'google' })).toBeInstanceOf(
    GoogleTranscriptionAdapter,
  );
});

it('refuses a route nobody serves rather than picking one', () => {
  expect(() => chooseTranscriptionAdapter({ MODEL_ROUTE: 'whisper' })).toThrow(
    /must be "direct" or "google"/,
  );
});

// Where the model map sends image generation to Gemini, the DALL-E fallback
// must not exist: there is no OpenAI account for it to belong to, so reaching for one
// would fail on a deliberately absent key instead of on the real problem.

const imagesGenerate = jest.fn();
const openAiCtor = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options: unknown) => {
    openAiCtor(options);
    return { images: { generate: imagesGenerate } };
  }),
}));

jest.mock('../../adapters/registry', () => ({ services: {} }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { generateImage } from '../file_generation';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.MODEL_MAP;
  // No Google service account: the branch that would otherwise reach for DALL-E.
  delete process.env.GOOGLE_PRIVATE_KEY;
  delete process.env.GOOGLE_CLIENT_EMAIL;
  delete process.env.GOOGLE_PROJECT_ID;
  imagesGenerate.mockReset().mockResolvedValue({ data: [{ b64_json: 'AAAA' }] });
  openAiCtor.mockClear();
});

afterAll(() => {
  process.env = SAVED_ENV;
});

it('still falls back to DALL-E when the map leaves it at home', async () => {
  // It gets as far as OpenAI and then fails on storage, which is not wired here
  // — what matters is that the OpenAI client was built and asked.
  await expect(generateImage({ prompt: 'a leaf', title: 't' })).rejects.toThrow();
  expect(imagesGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: 'dall-e-3' }));
});

it('names the missing Google credentials when mapped to Gemini, and builds no OpenAI client', async () => {
  process.env.MODEL_MAP = JSON.stringify({ 'dall-e-3': 'gemini/gemini-3-pro-image' });
  await expect(generateImage({ prompt: 'a leaf', title: 't' })).rejects.toThrow(
    /MODEL_MAP sends dall-e-3 to gemini.*GOOGLE_PRIVATE_KEY/s,
  );
  expect(openAiCtor).not.toHaveBeenCalled();
  expect(imagesGenerate).not.toHaveBeenCalled();
});

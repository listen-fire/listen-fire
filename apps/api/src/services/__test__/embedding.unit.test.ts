// Embedding on either provider: which model, how wide the vector, and what happens
// to a text the provider would otherwise quietly cut in half.

const embeddingsCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ embeddings: { create: embeddingsCreate } })),
}));

const recordLlmUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../lib/llm_usage', () => ({
  recordLlmUsage: (...args: unknown[]) => recordLlmUsage(...args),
}));

// Only the token minting is mocked; the URL builder is the real one, reading
// the real environment — which is the half of this worth asserting.
const bearerToken = jest.fn().mockResolvedValue('ya29.token');
jest.mock('../../lib/google_cloud', () => ({
  ...jest.requireActual('../../lib/google_cloud'),
  googleBearerTokens: () => bearerToken,
}));

/** Both embedding models sent to Gemini, as a Google-only deployment maps them. */
const GEMINI_MAP = JSON.stringify({
  'text-embedding-3-large': 'gemini/gemini-embedding-001',
  'text-embedding-3-small': 'gemini/gemini-embedding-001',
});

// The knowledge query builder is only reached by `embedAndStore`, which these
// tests do not exercise — but the module builds one at import.
jest.mock('../../lib/kysely', () => ({ getKnowledgeQb: jest.fn(), getQb: jest.fn() }));

import { embedTexts } from '../embedding';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/** One Google prediction of `width` numbers, all equal, so the magnitude is
 *  knowable: a vector of n copies of 1 has magnitude sqrt(n). */
function prediction(width: number) {
  return {
    embeddings: { values: Array.from({ length: width }, () => 1), statistics: { token_count: 4 } },
  };
}

function googleResponds(width: number) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ predictions: [prediction(width)] }),
  });
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.MODEL_MAP;
  process.env.GOOGLE_PRIVATE_KEY = 'pk';
  process.env.GOOGLE_CLIENT_EMAIL = 'robot@example.iam.gserviceaccount.com';
  process.env.GOOGLE_PROJECT_ID = 'a-project';
  delete process.env.GOOGLE_MODEL_REGION;
  fetchMock.mockReset();
  embeddingsCreate.mockReset();
  recordLlmUsage.mockClear();
  bearerToken.mockClear();
});

afterAll(() => {
  process.env = SAVED_ENV;
});

describe('nothing to embed', () => {
  it('asks nobody', async () => {
    await expect(embedTexts({ texts: [], destination: 'raw_text' })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });
});

describe('OpenAI, where the map leaves embeddings at home', () => {
  beforeEach(() => {
    embeddingsCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { total_tokens: 7 },
    });
  });

  it('sends raw_text to the large model at its native width', async () => {
    await embedTexts({ texts: ['hello'], destination: 'raw_text' });
    // No `dimensions`: 3072 is native, and naming it would change a request
    // that works today for no gain.
    expect(embeddingsCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: ['hello'],
    });
  });

  it('sends extraction_fact to the small model at 256', async () => {
    await embedTexts({ texts: ['hello'], destination: 'extraction_fact' });
    expect(embeddingsCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: ['hello'],
      dimensions: 256,
    });
  });

  it('bills OpenAI', async () => {
    await embedTexts({ texts: ['hello'], destination: 'raw_text', label: 'l' });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'text-embedding-3-large', inputTokens: 7 }),
    );
  });
});

describe('Gemini, where the map sends embeddings', () => {
  beforeEach(() => {
    process.env.MODEL_MAP = GEMINI_MAP;
  });

  it('asks for exactly the width the destination column stores', async () => {
    googleResponds(3072);
    await embedTexts({ texts: ['hello'], destination: 'raw_text' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/a-project/locations/global' +
        '/publishers/google/models/gemini-embedding-001:predict',
    );
    expect(JSON.parse(init.body)).toEqual({
      instances: [{ content: 'hello' }],
      parameters: { autoTruncate: false, outputDimensionality: 3072 },
    });
    expect(init.headers.Authorization).toBe('Bearer ya29.token');
  });

  it('asks for 256 when that is what the column stores', async () => {
    googleResponds(256);
    await embedTexts({ texts: ['hello'], destination: 'extraction_fact' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).parameters.outputDimensionality).toBe(256);
  });

  it('refuses silent truncation rather than accepting a prefix as the text', async () => {
    googleResponds(3072);
    await embedTexts({ texts: ['hello'], destination: 'raw_text' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).parameters.autoTruncate).toBe(false);
  });

  it('puts a shortened vector back on the unit sphere', async () => {
    googleResponds(256);
    const [vector] = await embedTexts({ texts: ['hello'], destination: 'extraction_fact' });
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it('leaves a full-length vector alone, because Google normalised it already', async () => {
    googleResponds(3072);
    const [vector] = await embedTexts({ texts: ['hello'], destination: 'raw_text' });
    expect(vector[0]).toBe(1);
  });

  it('sends one text per request', async () => {
    googleResponds(3072);
    await embedTexts({ texts: ['one', 'two', 'three'], destination: 'raw_text' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).instances).toEqual([{ content: 'two' }]);
  });

  it('refuses a text over the model’s per-text token limit', async () => {
    // Far past 2048 tokens, and nothing upstream can produce this: raw_text is
    // chunked at 256 tokens and a fact is a triple.
    const huge = 'word '.repeat(9000);
    await expect(embedTexts({ texts: [huge], destination: 'raw_text' })).rejects.toThrow(
      /over the 2048-token limit/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a vector that is not the width it asked for', async () => {
    googleResponds(768);
    await expect(embedTexts({ texts: ['hello'], destination: 'raw_text' })).rejects.toThrow(
      /768-dimension vector for raw_text, which stores 3072/,
    );
  });

  it('surfaces Google’s own refusal rather than a shrug', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'model not enabled' });
    await expect(embedTexts({ texts: ['hello'], destination: 'raw_text' })).rejects.toThrow(
      /Google embedding error 403: model not enabled/,
    );
  });

  it('bills Google, under Google’s model name', async () => {
    googleResponds(3072);
    await embedTexts({ texts: ['hello'], destination: 'raw_text', label: 'l' });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        model: 'gemini-embedding-001',
        callType: 'embedding',
        inputTokens: 4,
      }),
    );
  });
});

// What the wrapper actually puts on the wire when the model map sends it to Gemini.
//
// Google's endpoint IGNORES a request option it does not support rather than
// refusing it, so a request that quietly loses half its options is
// indistinguishable from one that worked. Nothing at runtime can tell the
// difference — which is why the check is here, against the documented list,
// once, on the real request each wrapper function builds.

const create = jest.fn();
const parse = jest.fn();
const wireModel = jest.fn();
const recordLlmUsage = jest.fn().mockResolvedValue(undefined);

jest.mock('../client', () => {
  const actual = jest.requireActual('../client');
  return {
    ...actual,
    platformOpenAI: (model: string) => ({
      client: { chat: { completions: { create, parse } } },
      wireModel: wireModel(model),
      provider: 'google',
    }),
  };
});

jest.mock('../../llm_usage', () => ({ recordLlmUsage: (...args: unknown[]) => recordLlmUsage(...args) }));
jest.mock('../../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { GOOGLE_SUPPORTED_CHAT_PARAMS } = jest.requireActual('../client');
import { openAiChat, openAiChatStructured } from '..';

const usage = { prompt_tokens: 11, completion_tokens: 22 };

beforeEach(() => {
  create.mockReset().mockResolvedValue({ choices: [{ message: { content: 'ok' } }], usage });
  parse.mockReset().mockResolvedValue({ choices: [{ message: { parsed: { ok: true } } }], usage });
  wireModel.mockReset().mockImplementation((model: string) =>
    model === 'o3' ? 'google/gemini-3.1-pro-preview' : 'google/gemini-3.8-flash',
  );
  recordLlmUsage.mockClear();
});

describe('every option we send is one Google documents', () => {
  it('holds for openAiChat, with and without caller options', async () => {
    await openAiChat([{ role: 'user', content: 'hi' }]);
    await openAiChat([{ role: 'user', content: 'hi' }], { model: 'gpt-4.1', temperature: 0.3 });
    await openAiChat([{ role: 'user', content: 'hi' }], { model: 'gpt-5-nano' });

    for (const [body] of create.mock.calls) {
      for (const key of Object.keys(body)) {
        expect(GOOGLE_SUPPORTED_CHAT_PARAMS.has(key)).toBe(true);
      }
    }
  });

  it('holds for openAiChatStructured, including its json_schema', async () => {
    await openAiChatStructured([{ role: 'user', content: 'hi' }]);
    await openAiChatStructured([{ role: 'user', content: 'hi' }], {
      model: 'gpt-5-mini',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'p', schema: { type: 'object', properties: {} } },
      },
    });

    for (const [body] of parse.mock.calls) {
      for (const key of Object.keys(body)) {
        expect(GOOGLE_SUPPORTED_CHAT_PARAMS.has(key)).toBe(true);
      }
    }
  });
});

describe('temperature follows the model actually being sent', () => {
  it('keeps it for a Gemini standing in for an o-series name', async () => {
    // On OpenAI's own API `gpt-5-nano` rejects any temperature but the default,
    // so the wrapper strips it. The Gemini answering for that name does not.
    await openAiChat([{ role: 'user', content: 'hi' }], { model: 'gpt-5-nano' });
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'google/gemini-3.8-flash',
      temperature: 0,
    });
  });
});

describe('the usage ledger and the recording hash disagree on purpose', () => {
  it('bills the Gemini that answered, not the model the caller named', async () => {
    await openAiChat([{ role: 'user', content: 'hi' }], { model: 'gpt-4.1' });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', model: 'google/gemini-3.8-flash' }),
    );
  });

  it('bills the flagship for a reasoning model', async () => {
    await openAiChatStructured([{ role: 'user', content: 'hi' }]);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', model: 'google/gemini-3.1-pro-preview' }),
    );
  });
});

describe('a schema Google would silently ignore', () => {
  it('is refused before the request leaves', async () => {
    await expect(
      openAiChatStructured([{ role: 'user', content: 'hi' }], {
        model: 'o3',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'tree',
            schema: {
              $ref: '#/$defs/Node',
              $defs: {
                Node: { type: 'object', properties: { kids: { items: { $ref: '#/$defs/Node' } } } },
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/recursive/);
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('a model name outside the registry', () => {
  it('is refused before any client is asked', async () => {
    await expect(
      openAiChat([{ role: 'user', content: 'hi' }], { model: 'gpt-3.5-turbo' }),
    ).rejects.toThrow(/The OpenAI chat model is "gpt-3.5-turbo"/);
    expect(create).not.toHaveBeenCalled();
  });
});

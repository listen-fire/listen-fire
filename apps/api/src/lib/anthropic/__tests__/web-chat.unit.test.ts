// Anthropic's server-side web tools, as the wrapper reads them back.
//
// Three shapes decide whether a caller sees the truth: a search whose result
// is a LIST of hits, a search whose result is an error OBJECT inside the same
// 200, and a turn that stops at `pause_turn` because the server-side loop hit
// its own ceiling. The first two are indistinguishable to a reader that
// assumes a list, and the third is a silently truncated answer.

import Anthropic from '@anthropic-ai/sdk';

const finalMessage = jest.fn();
const stream = jest.fn(
  (_params: Record<string, unknown>, _options?: { signal?: AbortSignal }) => ({ finalMessage }),
);

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { stream } })),
}));

jest.mock('../../llm_usage', () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined),
  runFields: jest.fn().mockReturnValue({}),
}));

const warn = jest.fn();
jest.mock('../../../services/logger', () => ({
  logger: { info: jest.fn(), warn, error: jest.fn() },
}));

import { anthropicWebChat, meterAnthropicUsage } from '../index';

// The tool result blocks postdate the pinned SDK's types, so the fixtures are
// the wire shapes rather than SDK values — which is the point: the wrapper has
// to read them structurally.
function reply(options: {
  content: unknown[];
  stopReason: Anthropic.StopReason;
  searches?: number;
  fetches?: number;
}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: options.stopReason,
    stop_sequence: null,
    content: options.content as Anthropic.Message['content'],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: {
        web_search_requests: options.searches ?? 0,
        web_fetch_requests: options.fetches ?? 0,
      },
    } as unknown as Anthropic.Usage,
  };
}

const SEARCH_ASKED = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'web_search',
  input: { query: '"Larkfield" canteen Denmark' },
};

const FETCH_ASKED = {
  type: 'server_tool_use',
  id: 'srvtoolu_2',
  name: 'web_fetch',
  input: { url: 'https://larkfield.example' },
};

beforeEach(() => {
  jest.clearAllMocks();
});

function call() {
  return anthropicWebChat({
    system: 'research one subject',
    userMessage: 'Subject: Larkfield',
    maxSearches: 6,
    maxFetches: 3,
  });
}

describe('a search that returned hits', () => {
  it('reads the hits, and pairs them with the query that asked for them', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        searches: 1,
        content: [
          SEARCH_ASKED,
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://larkfield.example',
                title: 'Larkfield — canteen software',
                page_age: '2026-01-02',
                encrypted_content: 'xxx',
              },
              {
                type: 'web_search_result',
                url: 'https://news.example/larkfield',
                title: 'Larkfield raises',
                page_age: null,
                encrypted_content: 'yyy',
              },
            ],
          },
          { type: 'text', text: 'Larkfield sells canteen software.' },
        ],
      }),
    );

    const result = await call();

    expect(result.text).toBe('Larkfield sells canteen software.');
    expect(result.events).toEqual([
      {
        kind: 'search',
        query: '"Larkfield" canteen Denmark',
        results: [
          { url: 'https://larkfield.example', title: 'Larkfield — canteen software', pageAge: '2026-01-02' },
          { url: 'https://news.example/larkfield', title: 'Larkfield raises', pageAge: null },
        ],
      },
    ]);
    expect(result.usage.searches).toBe(1);
    expect(result.resumes).toBe(0);
  });
});

describe('a server tool that failed inside a 200', () => {
  it('reads the error object as a failure rather than as an empty result', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        searches: 1,
        content: [
          SEARCH_ASKED,
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
          },
          FETCH_ASKED,
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srvtoolu_2',
            content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
          },
          { type: 'text', text: 'I could not check.' },
        ],
      }),
    );

    const result = await call();

    expect(result.events).toEqual([
      { kind: 'search_failed', query: '"Larkfield" canteen Denmark', errorCode: 'max_uses_exceeded' },
      { kind: 'fetch_failed', url: 'https://larkfield.example', errorCode: 'url_not_accessible' },
    ]);
  });
});

describe('a page that was read', () => {
  it('carries the address, the timestamp and the text back', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        fetches: 1,
        content: [
          FETCH_ASKED,
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srvtoolu_2',
            content: {
              type: 'web_fetch_result',
              url: 'https://larkfield.example',
              retrieved_at: '2026-09-10T00:00:00Z',
              content: {
                type: 'document',
                title: 'Larkfield',
                citations: null,
                source: { type: 'text', media_type: 'text/plain', data: 'Canteen ordering.' },
              },
            },
          },
        ],
      }),
    );

    const result = await call();

    expect(result.events).toEqual([
      {
        kind: 'fetch',
        url: 'https://larkfield.example',
        retrievedAt: '2026-09-10T00:00:00Z',
        text: 'Canteen ordering.',
      },
    ]);
    expect(result.usage.fetches).toBe(1);
  });
});

describe('a paused turn', () => {
  it('re-sends the conversation unchanged and keeps both halves of the answer', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({
          stopReason: 'pause_turn',
          searches: 1,
          content: [
            SEARCH_ASKED,
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
            { type: 'text', text: 'Still looking. ' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        reply({
          stopReason: 'end_turn',
          searches: 1,
          content: [{ type: 'text', text: 'Larkfield sells canteen software.' }],
        }),
      );

    const result = await call();

    expect(result.resumes).toBe(1);
    expect(result.text).toBe('Still looking. Larkfield sells canteen software.');
    expect(result.stopReason).toBe('end_turn');
    // Both halves of the usage, and both turns' searches.
    expect(result.usage.searches).toBe(2);
    expect(result.usage.inputTokens).toBe(200);

    // The resume is the paused assistant turn appended and nothing else — an
    // added "continue" user turn is the one thing that stops the server
    // resuming on its own.
    const second = stream.mock.calls[1][0] as unknown as Anthropic.MessageCreateParams;
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1].role).toBe('assistant');
  });

  it('stops at the resume ceiling rather than pausing forever', async () => {
    finalMessage.mockResolvedValue(
      reply({ stopReason: 'pause_turn', content: [{ type: 'text', text: 'x' }] }),
    );

    const result = await call();

    expect(result.stopReason).toBe('pause_turn');
    expect(result.resumes).toBe(3);
    expect(stream).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      '[anthropic] web chat still paused at the resume ceiling',
      expect.anything(),
    );
  });
});

describe('the request', () => {
  it('declares both tools at the caller’s caps, with no beta header', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );

    await anthropicWebChat({
      system: 's',
      userMessage: 'u',
      maxSearches: 4,
      maxFetches: 2,
      effort: 'medium',
    });

    const request = stream.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(request.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
      // Uncapped, one large page rides along in every later server-side
      // iteration — which is where a five-minute turn's time goes.
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, max_content_tokens: 6000 },
    ]);
    expect(request.betas).toBeUndefined();
    expect(request.output_config).toEqual({ effort: 'medium' });
  });

  it('hands the caller’s abort signal to the streaming request', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );
    const controller = new AbortController();

    await anthropicWebChat({ system: 's', userMessage: 'u', signal: controller.signal });

    // A caller with a deadline needs the request CANCELLED, not abandoned: an
    // abandoned turn goes on searching and billing after nobody is waiting.
    expect(stream.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });
});

describe('the usage meter', () => {
  it('reports what the calls underneath it spent', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        searches: 2,
        fetches: 1,
        content: [{ type: 'text', text: 'ok' }],
      }),
    );

    const { usage } = await meterAnthropicUsage(() => call());

    expect(usage).toMatchObject({
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      searches: 2,
      fetches: 1,
    });
  });

  it('counts nothing outside a metered scope', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );
    await expect(call()).resolves.toBeDefined();
  });
});

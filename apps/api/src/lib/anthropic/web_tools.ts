// Anthropic's SERVER-side web tools, read back as events.
//
// `web_search` and `web_fetch` run on Anthropic's infrastructure: the request
// declares them, the model uses them inside one turn, and the reply carries a
// `server_tool_use` block per request plus a result block per answer. Nothing
// here executes a tool — this file only reads what came back.
//
// Two shapes bite anyone reading those blocks for the first time:
//
//   - A FAILED server tool is still an HTTP 200. The failure is an error
//     OBJECT where the result would be, so a reader that assumes the search
//     result is a list silently treats "the search was rate-limited" as "the
//     search found nothing", and the model's answer looks merely unlucky.
//   - A search result IS a list and a fetch result is NOT: one search returns
//     many hits, one fetch returns one document. Both branch on the block's
//     own `type` rather than on whether it is an array.
//
// The SDK's pinned version predates these tool versions, so the blocks are
// read structurally rather than through its types — the same crossing the
// request side makes.

/** The tool versions that filter results before they reach the context
 *  window. No beta header: they are generally available. */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';
export const WEB_FETCH_TOOL_TYPE = 'web_fetch_20260209';

/** How much of a fetched page is worth carrying back to the caller. The model
 *  has already read the whole thing server-side; this is for the caller that
 *  wants to quote it. */
const FETCHED_TEXT_CHARS = 8000;

/**
 * How much of a fetched page is allowed into the model's own context
 * (`max_content_tokens` on the fetch tool — the server truncates past it).
 *
 * Uncapped, one large page is tens of thousands of tokens, and a server-side
 * loop re-reads every page it has already opened on every later iteration. A
 * production entry re-read 443k cached tokens across a single turn, which is
 * where its five and a half minutes went. A page answers the questions in its
 * first few thousand tokens or it is the wrong page.
 */
export const WEB_FETCH_MAX_CONTENT_TOKENS = 6000;

/** What one server tool did, in the caller's terms. A failure is an event of
 *  its own rather than an absence — "the search was rate-limited" and "the
 *  search found nothing" are different answers. */
export type WebToolEvent =
  | {
      kind: 'search';
      query: string | null;
      results: Array<{ url: string; title: string; pageAge: string | null }>;
    }
  | { kind: 'search_failed'; query: string | null; errorCode: string }
  | { kind: 'fetch'; url: string; retrievedAt: string | null; text: string }
  | { kind: 'fetch_failed'; url: string | null; errorCode: string };

// ── Reading the blocks ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function errorCodeOf(content: unknown): string {
  return isRecord(content) ? (str(content.error_code) ?? 'unknown') : 'unknown';
}

/** The plain text of a fetched document, when it is text at all. A PDF comes
 *  back base64-encoded under a binary media type and is not worth decoding
 *  here — the model read it server-side, and the caller wants a quotable
 *  excerpt or nothing. */
function documentText(content: unknown): string {
  if (!isRecord(content)) return '';
  const source = content.source;
  if (!isRecord(source) || source.type !== 'text') return '';
  const data = str(source.data);
  return data ? data.slice(0, FETCHED_TEXT_CHARS) : '';
}

/**
 * Every server-tool request and its answer, in order, paired up by the
 * `tool_use_id` that links a result block back to the `server_tool_use` block
 * that asked for it — which is the only place the query text and the fetched
 * address appear.
 */
export function readWebToolEvents(content: readonly unknown[]): WebToolEvent[] {
  const asked = new Map<string, { name: string; query: string | null; url: string | null }>();
  const events: WebToolEvent[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === 'server_tool_use') {
      const id = str(block.id);
      const input = isRecord(block.input) ? block.input : {};
      if (id) {
        asked.set(id, {
          name: typeof block.name === 'string' ? block.name : '',
          query: str(input.query),
          url: str(input.url),
        });
      }
      continue;
    }

    const request = asked.get(str(block.tool_use_id) ?? '');

    if (block.type === 'web_search_tool_result') {
      const results = block.content;
      // A list is hits; anything else is the error object a failed search
      // returns inside a 200.
      if (Array.isArray(results)) {
        events.push({
          kind: 'search',
          query: request?.query ?? null,
          results: results.flatMap((hit) => {
            if (!isRecord(hit)) return [];
            const url = str(hit.url);
            return url
              ? [{ url, title: str(hit.title) ?? '', pageAge: str(hit.page_age) }]
              : [];
          }),
        });
      } else {
        events.push({
          kind: 'search_failed',
          query: request?.query ?? null,
          errorCode: errorCodeOf(results),
        });
      }
      continue;
    }

    if (block.type === 'web_fetch_tool_result') {
      const result = block.content;
      // Both outcomes are objects here — one fetch, one document — so the
      // branch is on the block's own type, never on its shape.
      if (isRecord(result) && result.type === 'web_fetch_result') {
        const url = str(result.url) ?? request?.url;
        if (url) {
          events.push({
            kind: 'fetch',
            url,
            retrievedAt: str(result.retrieved_at),
            text: documentText(result.content),
          });
          continue;
        }
      }
      events.push({
        kind: 'fetch_failed',
        url: request?.url ?? null,
        errorCode: errorCodeOf(result),
      });
    }
  }

  return events;
}

/** The text the model wrote, ignoring its thinking and its tool traffic. */
export function readAnswerText(content: readonly unknown[]): string {
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('');
}

/** How many server-tool requests Anthropic billed, as the reply reports them.
 *  Counted from the usage row rather than from the blocks: a request that
 *  produced no readable block was still made. */
export function readServerToolCounts(usage: unknown): { searches: number; fetches: number } {
  const server = isRecord(usage) ? usage.server_tool_use : null;
  const count = (value: unknown) => (typeof value === 'number' ? value : 0);
  return isRecord(server)
    ? { searches: count(server.web_search_requests), fetches: count(server.web_fetch_requests) }
    : { searches: 0, fetches: 0 };
}

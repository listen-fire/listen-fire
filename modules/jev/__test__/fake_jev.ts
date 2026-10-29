// A fake Jev for the module's tests and listen-fire's: the wire shapes are the
// platform's client's (lf-platform apps/api/src/lib/jev/client.ts), served on
// a loopback port under `/v1/systemone`.
//
// It answers by rule, so a test can say what it expects: a `noul` question is
// 0.83 when the state mentions the question's last word and 0.12 otherwise;
// a `choice` question picks the first option whose description the state
// mentions (else the first option), with confidence 0.91. `usage` counts one
// input token per four bytes of the request.

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeJevRequest {
  authorization: string | undefined;
  body: {
    model: string;
    state: unknown;
    questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string | null> }>;
  };
}

export interface FakeJev {
  /** The base URL a credential names: `http://127.0.0.1:<port>/v1`. */
  url: string;
  requests: FakeJevRequest[];
  /** Statuses to answer the next requests with, in order, before answering. */
  failNext(...statuses: number[]): void;
  close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

function mentions(state: unknown, word: string): boolean {
  const haystack = (typeof state === 'string' ? state : JSON.stringify(state)).toLowerCase();
  return word.length > 0 && haystack.includes(word.toLowerCase());
}

function lastWord(text: string): string {
  return (text.match(/[A-Za-z]+/g) ?? []).at(-1) ?? '';
}

export async function startFakeJev(options: { key: string }): Promise<FakeJev> {
  const requests: FakeJevRequest[] = [];
  const failures: number[] = [];
  const server = createServer(async (req, res) => {
    const raw = await bodyOf(req);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { error: 'not_found' });
    const body = JSON.parse(raw) as FakeJevRequest['body'];
    requests.push({ authorization: req.headers.authorization, body });
    const failure = failures.shift();
    if (failure !== undefined) return send(failure, { error: failure === 429 ? 'rate_limited' : 'overloaded' });
    if (req.headers.authorization !== `Bearer ${options.key}`) return send(401, { error: 'invalid_api_key' });
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions)) {
      if (question.type === 'noul') {
        answers[key] = { type: 'noul', noul: mentions(body.state, lastWord(question.instructions)) ? 0.83 : 0.12 };
      } else {
        const options = Object.entries(question.criteria ?? {});
        const chosen = options.find(([, description]) => mentions(body.state, description ?? '')) ?? options[0];
        const choice = chosen?.[0] ?? '';
        const rest = (1 - 0.91) / Math.max(1, options.length - 1);
        answers[key] = {
          type: 'choice',
          choice,
          confidence: 0.91,
          probabilities: Object.fromEntries(options.map(([option]) => [option, option === choice ? 0.91 : rest])),
        };
      }
    }
    send(200, { model: 'jev-1.12', answers, usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 1 } });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    failNext: (...statuses) => failures.push(...statuses),
    close: () => new Promise((done) => server.close(() => done())),
  };
}

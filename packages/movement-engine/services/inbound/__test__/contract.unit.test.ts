// The inbound doors' contract (../contract.ts) held by this package's door
// core, served over HTTP as a host serves it, over the contract's own
// in-memory stores: the TypeScript host the shared cases hold beside
// listen-fire's doors (apps/cli inbound_contract.test.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { INBOUND_CONTRACT_CASES, memoryInboundStores, type InboundContractBackend } from '../contract';
import { answerDelivery, PAYLOAD_TOO_LARGE, type InboundAnswer } from '../deliver';
import { answerEmit, answerWake } from '../push';

// The HTTP layer's limits, as a host's body parser sets them.
const WEBHOOK_BODY_LIMIT = 100 * 1024;
const PUSH_BODY_LIMIT = 1024 * 1024;

const WEBHOOK = /^\/api\/public\/webhook-sync\/([^/]+)\/([^/]+)$/;
const PUSH = /^\/api\/public\/adapter\/([^/]+)\/(emit|wake)$/;

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, answer: InboundAnswer): void {
  const text = answer.contentType !== undefined && typeof answer.body === 'string';
  response.writeHead(answer.status, { 'content-type': text ? answer.contentType : 'application/json' });
  response.end(text ? answer.body : JSON.stringify(answer.body));
  answer.afterAnswer?.();
}

function parsed(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf-8'));
  } catch {
    return undefined;
  }
}

let doors: ReturnType<typeof memoryInboundStores> | undefined;
let server: Server;
let baseUrl: string;

function arranged(): ReturnType<typeof memoryInboundStores> {
  if (doors === undefined) throw new Error('no world arranged');
  return doors;
}

async function answer(request: IncomingMessage): Promise<InboundAnswer> {
  const path = (request.url ?? '').split('?')[0] ?? '';
  const raw = await bodyOf(request);
  const webhook = WEBHOOK.exec(path);
  if (webhook) {
    if (raw.length > WEBHOOK_BODY_LIMIT) return PAYLOAD_TOO_LARGE;
    const { store, host } = arranged();
    return answerDelivery(store, host, {
      provider: decodeURIComponent(webhook[1] ?? ''),
      subscriptionId: decodeURIComponent(webhook[2] ?? ''),
      rawBody: raw,
      headers: request.headers,
      method: request.method ?? 'POST',
      path,
    });
  }
  const push = PUSH.exec(path);
  if (push) {
    if (raw.length > PUSH_BODY_LIMIT) return PAYLOAD_TOO_LARGE;
    const pushed = { adapterType: decodeURIComponent(push[1] ?? ''), headers: request.headers, body: parsed(raw) };
    return push[2] === 'emit' ? answerEmit(arranged().push, pushed) : answerWake(arranged().push, pushed);
  }
  return { status: 404, body: { error: 'not_found' } };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    answer(request).then(
      (answered) => send(response, answered),
      () => send(response, { status: 500, body: { error: 'internal' } }),
    );
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the doors are not listening on a port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

const backend: InboundContractBackend = {
  get baseUrl() {
    return baseUrl;
  },
  async arrange(world) {
    doors = memoryInboundStores(world);
  },
  async observed() {
    return arranged().observed();
  },
};

describe('the inbound doors contract, on the TypeScript door core', () => {
  it.each(INBOUND_CONTRACT_CASES.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    await entry.run(backend);
  });
});

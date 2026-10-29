// A fake Stripe API for the module's tests and lf's, served on a loopback port
// at the root (as api.stripe.com is). It answers the reads this module makes,
// in Stripe's shapes: retrieving a customer, an invoice or a subscription
// (`/v1/<kind>/<id>`, a 404 with Stripe's error body for none), and listing
// them (`{ object: "list", data, has_more, url }`, newest first, paged by
// `limit` and `starting_after`, narrowed by the query parameters Stripe
// documents for each). Like Stripe, a subscription listing leaves canceled
// ones out unless `status` asks for them. A wrong key is answered 401.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Json } from './fixtures';

export interface FakeStripeRequest {
  method: string;
  /** Path and query, as sent. */
  path: string;
  authorization: string | undefined;
  stripeVersion: string | undefined;
}

export interface FakeStripe {
  url: string;
  requests: FakeStripeRequest[];
  customer(object: Json): void;
  invoice(object: Json): void;
  subscription(object: Json): void;
  close(): Promise<void>;
}

const KINDS = ['customers', 'invoices', 'subscriptions'] as const;
type Kind = (typeof KINDS)[number];

/** The query parameters each listing narrows by: a parameter and the field it
 *  compares. */
const FILTERS: Record<Kind, Record<string, string>> = {
  customers: { email: 'email' },
  invoices: { customer: 'customer', status: 'status', collection_method: 'collection_method', subscription: 'subscription' },
  subscriptions: { customer: 'customer', status: 'status', collection_method: 'collection_method' },
};

function isKind(value: string | undefined): value is Kind {
  return (KINDS as readonly string[]).includes(value ?? '');
}

/** An invoice's subscription, where the current API puts it. */
function subscriptionOf(invoice: Json): unknown {
  const parent = invoice['parent'];
  const details = typeof parent === 'object' && parent !== null ? (parent as Json)['subscription_details'] : undefined;
  return typeof details === 'object' && details !== null ? (details as Json)['subscription'] : invoice['subscription'];
}

function matches(kind: Kind, object: Json, query: URLSearchParams): boolean {
  for (const [param, key] of Object.entries(FILTERS[kind])) {
    const wanted = query.get(param);
    if (wanted === null) continue;
    if (kind === 'subscriptions' && param === 'status' && wanted === 'all') continue;
    const held = kind === 'invoices' && key === 'subscription' ? subscriptionOf(object) : object[key];
    if (held !== wanted) return false;
  }
  if (kind === 'subscriptions' && query.get('status') === null && object['status'] === 'canceled') return false;
  return true;
}

export async function startFakeStripe(options: { apiKey: string }): Promise<FakeStripe> {
  const store: Record<Kind, Json[]> = { customers: [], invoices: [], subscriptions: [] };
  const requests: FakeStripeRequest[] = [];

  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    requests.push({ method: req.method ?? 'GET', path, authorization: header('authorization'), stripeVersion: header('stripe-version') });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_${requests.length}` });
      res.end(JSON.stringify(body));
    };
    const error = (status: number, type: string, message: string) => send(status, { error: { type, message } });
    if (header('authorization') !== `Bearer ${options.apiKey}`) return error(401, 'invalid_request_error', 'Invalid API Key provided');
    const url = new URL(path, 'http://fake');
    const [, version, kind, id, ...rest] = url.pathname.split('/');
    if (req.method !== 'GET' || version !== 'v1' || !isKind(kind) || rest.length > 0) return error(404, 'invalid_request_error', `Unrecognized request URL (${req.method}: ${url.pathname}).`);
    if (id !== undefined && id !== '') {
      const found = store[kind].find((object) => object['id'] === decodeURIComponent(id));
      return found !== undefined ? send(200, found) : error(404, 'invalid_request_error', `No such ${kind.slice(0, -1)}: '${id}'`);
    }
    const all = store[kind].filter((object) => matches(kind, object, url.searchParams)).sort((a, b) => Number(b['created']) - Number(a['created']));
    const after = url.searchParams.get('starting_after');
    const start = after === null ? 0 : all.findIndex((object) => object['id'] === after) + 1;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '10'), 100);
    const data = all.slice(start, start + limit);
    return send(200, { object: 'list', data, has_more: start + limit < all.length, url: `/v1/${kind}` });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  const add = (kind: Kind) => (object: Json) => {
    store[kind] = [...store[kind].filter((held) => held['id'] !== object['id']), object];
  };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    customer: add('customers'),
    invoice: add('invoices'),
    subscription: add('subscriptions'),
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

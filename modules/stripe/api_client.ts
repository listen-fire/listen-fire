// Stripe REST client and the normalisation of Stripe's objects into the flat
// payloads positions carry — shared by the reads (adapter.ts) and the door
// (inbound.ts), because an event's object and a fetched one are the same
// shape. Reads only: this module writes nothing to Stripe. It reaches Stripe
// through the fetch and the log its host hands the module, never the
// process's own.
//
// Objects are read defensively: an event is shaped by the API version of the
// endpoint that sent it, which need not be the version reads pin. So an
// invoice's subscription is read where the current API puts it
// (`parent.subscription_details.subscription`) and where versions before
// 2025-03-31 put it (`subscription`), and an id that arrives expanded into
// its object is read from the object.

import { z } from 'zod';

import { retryingFetch, type ModuleLog, type RetryFetchOptions } from 'module-kit';

import { majorUnits } from './money';
import type { StripeCustomerPayload, StripeInvoicePayload, StripeSubscriptionPayload } from './types';

export const STRIPE_DEFAULT_BASE_URL = 'https://api.stripe.com';
/** The API version every read pins, so a read's shape does not move with the
 *  account's default version. */
export const STRIPE_API_VERSION = '2025-03-31.basil';

/** Stored Stripe credential: the API key reads go out with (a restricted,
 *  read-only key is enough), and the webhook endpoint's signing secret the
 *  door checks deliveries against. */
export const stripeCredsParser = z.object({
  apiKey: z.string().min(1),
  webhookSecret: z.string().optional(),
});
export type StripeCredentials = z.infer<typeof stripeCredsParser>;

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

// ── Reading Stripe's objects ────────────────────────────────────────────────

export type StripeObject = Record<string, unknown>;

export function isObject(value: unknown): value is StripeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(o: StripeObject, key: string): string | null {
  const value = o[key];
  return typeof value === 'string' ? value : null;
}

function count(o: StripeObject, key: string): number | null {
  const value = o[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function flag(o: StripeObject, key: string): boolean | null {
  const value = o[key];
  return typeof value === 'boolean' ? value : null;
}

/** A Stripe timestamp (unix seconds) as ISO 8601. */
function instant(o: StripeObject, key: string): string | null {
  const seconds = count(o, key);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function metadata(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** An id that may arrive expanded into its object. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (isObject(value) && typeof value['id'] === 'string') return value['id'];
  return null;
}

/** The object's kind (`object: "invoice"`). */
export function objectKind(o: StripeObject): string | null {
  return text(o, 'object');
}

export function normalizeCustomer(o: StripeObject): StripeCustomerPayload {
  const currency = text(o, 'currency');
  return {
    id: text(o, 'id') ?? '',
    email: text(o, 'email'),
    name: text(o, 'name'),
    description: text(o, 'description'),
    phone: text(o, 'phone'),
    currency,
    balance: majorUnits(count(o, 'balance'), currency),
    delinquent: flag(o, 'delinquent'),
    created: instant(o, 'created'),
    livemode: flag(o, 'livemode') ?? false,
    metadata: metadata(o['metadata']),
    deleted: flag(o, 'deleted') ?? false,
  };
}

export function normalizeInvoice(o: StripeObject): StripeInvoicePayload {
  const currency = text(o, 'currency') ?? '';
  const amount = (key: string) => majorUnits(count(o, key), currency);
  const parent = isObject(o['parent']) ? o['parent'] : {};
  const details = isObject(parent['subscription_details']) ? parent['subscription_details'] : {};
  return {
    id: text(o, 'id') ?? '',
    number: text(o, 'number'),
    status: text(o, 'status'),
    currency,
    amount_due: amount('amount_due'),
    amount_paid: amount('amount_paid'),
    amount_remaining: amount('amount_remaining'),
    subtotal: amount('subtotal'),
    total: amount('total'),
    customer_email: text(o, 'customer_email'),
    customer_name: text(o, 'customer_name'),
    hosted_invoice_url: text(o, 'hosted_invoice_url'),
    invoice_pdf: text(o, 'invoice_pdf'),
    billing_reason: text(o, 'billing_reason'),
    collection_method: text(o, 'collection_method'),
    attempt_count: count(o, 'attempt_count'),
    attempted: flag(o, 'attempted'),
    next_payment_attempt: instant(o, 'next_payment_attempt'),
    due_date: instant(o, 'due_date'),
    period_start: instant(o, 'period_start'),
    period_end: instant(o, 'period_end'),
    created: instant(o, 'created'),
    description: text(o, 'description'),
    livemode: flag(o, 'livemode') ?? false,
    metadata: metadata(o['metadata']),
    customer: idOf(o['customer']),
    subscription: idOf(details['subscription']) ?? idOf(o['subscription']),
  };
}

export function normalizeSubscription(o: StripeObject): StripeSubscriptionPayload {
  return {
    id: text(o, 'id') ?? '',
    status: text(o, 'status') ?? '',
    currency: text(o, 'currency'),
    collection_method: text(o, 'collection_method'),
    cancel_at_period_end: flag(o, 'cancel_at_period_end'),
    cancel_at: instant(o, 'cancel_at'),
    canceled_at: instant(o, 'canceled_at'),
    ended_at: instant(o, 'ended_at'),
    start_date: instant(o, 'start_date'),
    trial_start: instant(o, 'trial_start'),
    trial_end: instant(o, 'trial_end'),
    created: instant(o, 'created'),
    description: text(o, 'description'),
    days_until_due: count(o, 'days_until_due'),
    livemode: flag(o, 'livemode') ?? false,
    metadata: metadata(o['metadata']),
    customer: idOf(o['customer']),
    latest_invoice: idOf(o['latest_invoice']),
  };
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface StripeClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** The host's fetch. */
  fetch: typeof fetch;
  log: ModuleLog;
  /** Retry policy overrides (tests shorten the waits). */
  retry?: RetryFetchOptions;
}

/** The query parameters a listing takes; each is one of Stripe's own. */
export type StripeListQuery = Record<string, string>;

/** Most rows Stripe hands back per page. */
const PAGE_SIZE = 100;

export class StripeClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StripeClientOptions) {
    this.base = (options.baseUrl ?? STRIPE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    // Every call is a GET, so every one may be sent again.
    this.fetchImpl = retryingFetch(options.fetch, {
      ...options.retry,
      onRetry: (note) => options.log.warn(`[stripe] ${note.because}; retry ${note.attempt}/${note.of} in ${note.waitMs}ms`),
    });
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Stripe-Version': STRIPE_API_VERSION, 'User-Agent': 'listen-fire' },
    });
    const body = await res.text();
    if (!res.ok) throw new StripeApiError(res.status, refusal(res.status, body, path), body);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new StripeApiError(res.status, `Stripe answered ${path} with a body that is not JSON`, body);
    }
  }

  private async one(path: string): Promise<StripeObject> {
    const answer = await this.get(path);
    if (!isObject(answer)) throw new StripeApiError(200, `Stripe answered ${path} with something that is not an object`, JSON.stringify(answer));
    return answer;
  }

  /** Every page of a listing, or the first `limit` rows. Stripe pages by
   *  cursor: the next page starts after the last id of this one. */
  private async list(path: string, query: StripeListQuery, limit?: number): Promise<StripeObject[]> {
    const rows: StripeObject[] = [];
    let after: string | undefined;
    for (;;) {
      const size = limit !== undefined ? Math.min(PAGE_SIZE, Math.max(limit - rows.length, 0)) : PAGE_SIZE;
      if (size === 0) break;
      const params = new URLSearchParams(query);
      params.set('limit', String(size));
      if (after !== undefined) params.set('starting_after', after);
      const page = await this.get(`${path}?${params}`);
      const data = isObject(page) && Array.isArray(page['data']) ? page['data'].filter(isObject) : [];
      rows.push(...data);
      const last = data.at(-1);
      after = last !== undefined ? text(last, 'id') ?? undefined : undefined;
      if (!(isObject(page) && page['has_more'] === true) || after === undefined) break;
    }
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  /** `GET /v1/customers`, newest first; `email` narrows to that address. */
  listCustomers(query: StripeListQuery, limit?: number): Promise<StripeObject[]> {
    return this.list('/v1/customers', query, limit);
  }

  /** `GET /v1/invoices`, newest first; `customer`, `subscription`, `status`
   *  and `collection_method` narrow it. */
  listInvoices(query: StripeListQuery, limit?: number): Promise<StripeObject[]> {
    return this.list('/v1/invoices', query, limit);
  }

  /** `GET /v1/subscriptions`, newest first. Stripe leaves canceled ones out
   *  unless `status` says otherwise, so a walk asks for `all` when the WHERE
   *  pins no status (filter.ts). */
  listSubscriptions(query: StripeListQuery, limit?: number): Promise<StripeObject[]> {
    return this.list('/v1/subscriptions', query, limit);
  }

  getCustomer(id: string): Promise<StripeObject> {
    return this.one(`/v1/customers/${encodeURIComponent(id)}`);
  }

  getInvoice(id: string): Promise<StripeObject> {
    return this.one(`/v1/invoices/${encodeURIComponent(id)}`);
  }

  getSubscription(id: string): Promise<StripeObject> {
    return this.one(`/v1/subscriptions/${encodeURIComponent(id)}`);
  }
}

/** What a refused read says, with what the author can do about it. */
function refusal(status: number, body: string, path: string): string {
  const said = (() => {
    try {
      const parsed: unknown = JSON.parse(body);
      const error = isObject(parsed) && isObject(parsed['error']) ? parsed['error'] : undefined;
      const message = error?.['message'];
      return typeof message === 'string' ? message : body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  })();
  if (status === 401) return `Stripe refused the API key (401): check the apiKey of the @lf/stripe credential. ${said}`.trim();
  if (status === 403) return `Stripe refused the read of ${path} (403): a restricted key needs Read on Customers, Invoices and Subscriptions. ${said}`.trim();
  if (status === 404) return `Stripe has no ${path} (404). ${said}`.trim();
  if (status === 429) return `Stripe's rate limit for this key is spent (429). ${said}`.trim();
  return `Stripe API ${status}: ${said}`;
}

// Stripe adapter — customers, invoices and subscriptions as a read-only
// graph, and the door Stripe's webhook deliveries come through.
//
// The type graph is `schema.ts`; the WHERE pushdown is `filter.ts`; the door
// is `inbound.ts`; the API and the normalisation of Stripe's objects are
// `api_client.ts`. Nothing is written to Stripe.

import type { Adapter, EdgesFromResult, EventType, GetFieldValueInput, GetRelatedInput, InboundCheck, InboundCheckInput, RelatedResult } from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import { ADAPTER_META_TYPE_ID, META_RECORD_TYPE, makeStablePosition, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';

import {
  StripeApiError,
  isObject,
  normalizeCustomer,
  normalizeInvoice,
  normalizeSubscription,
  objectKind,
  type StripeClient,
  type StripeListQuery,
  type StripeObject,
} from './api_client';
import { customerQueryFromWhere, invoiceQueryFromWhere, subscriptionQueryFromWhere } from './filter';
import { checkStripeDelivery, type StripeDoorSources } from './inbound';
import { STRIPE_MANIFEST } from './manifest';
import { STRIPE_ACCOUNT_DESCRIPTOR, STRIPE_ROOT, describeStripeType, stripeEntryPoints } from './schema';
import {
  STRIPE_ACCOUNT_TYPE_ID,
  STRIPE_ADAPTER_TYPE,
  STRIPE_CUSTOMERS_COLLECTION,
  STRIPE_CUSTOMER_DISPLAY_NAME,
  STRIPE_CUSTOMER_EDGE,
  STRIPE_EVENT_DISPLAY_NAME,
  STRIPE_EVENT_TAG,
  STRIPE_EVENT_TYPE_ID,
  STRIPE_INVOICES_COLLECTION,
  STRIPE_INVOICES_EDGE,
  STRIPE_INVOICE_DISPLAY_NAME,
  STRIPE_INVOICE_EDGE,
  STRIPE_INVOICE_STATUSES,
  STRIPE_LATEST_INVOICE_EDGE,
  STRIPE_SUBSCRIPTIONS_COLLECTION,
  STRIPE_SUBSCRIPTIONS_EDGE,
  STRIPE_SUBSCRIPTION_DISPLAY_NAME,
  STRIPE_SUBSCRIPTION_EDGE,
  STRIPE_SUBSCRIPTION_STATUSES,
} from './types';

/** Where the adapter gets a credentialed client. */
export type StripeClientSource = () => Promise<StripeClient>;

export class StripeAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = STRIPE_ADAPTER_TYPE;
  readonly supportedTriggers = STRIPE_MANIFEST.supportedTriggers;

  /** `client` hands back a credentialed client per call and throws, naming
   *  why, when the credential holds no API key; `door` is what a delivery is
   *  checked against. Either is the module's from its context, a test's over
   *  a fake. */
  constructor(
    private readonly client: StripeClientSource,
    private readonly door: StripeDoorSources,
  ) {
    super();
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return stripeEntryPoints();
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === STRIPE_ACCOUNT_TYPE_ID) return STRIPE_ACCOUNT_DESCRIPTOR;
    return describeStripeType(await this.resolveTypeRef(typeRef));
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: STRIPE_ADAPTER_TYPE,
      at: position,
      root: STRIPE_ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  // ── 2. Field-level access ──────────────────────────────────────────────
  // Every position carries its record inline, keyed by field id, so the
  // base class's lookup reads it.

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== STRIPE_ADAPTER_TYPE) {
      throw new Error(`StripeAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`);
    }
    return super.getFieldValue(input);
  }

  // ── 3. Traversal ───────────────────────────────────────────────────────

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== STRIPE_ADAPTER_TYPE) {
      throw new Error(`StripeAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`);
    }
    if (input.direction !== 'outgoing') return [];

    // The root's collection names cross VERBATIM (a meta position carries no
    // type to resolve an edge against), so match them before the resolver.
    if (input.position.recordType === META_RECORD_TYPE) return this.rootCollection(input);

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    const held = positionData(input.position);
    const data: StripeObject = isObject(held) ? held : {};
    if (input.position.recordType === STRIPE_EVENT_DISPLAY_NAME) return eventObject(data, edgeId);

    const id = typeof data['id'] === 'string' ? data['id'] : '';
    const linked = (key: string) => (typeof data[key] === 'string' && data[key] !== '' ? data[key] : undefined);
    switch (edgeId) {
      case STRIPE_CUSTOMER_EDGE: {
        const customer = linked('customer');
        return customer === undefined ? [] : this.fetched(async (client) => customerPosition(await client.getCustomer(customer)));
      }
      case STRIPE_SUBSCRIPTION_EDGE: {
        const subscription = linked('subscription');
        return subscription === undefined ? [] : this.fetched(async (client) => subscriptionPosition(await client.getSubscription(subscription)));
      }
      case STRIPE_LATEST_INVOICE_EDGE: {
        const invoice = linked('latest_invoice');
        return invoice === undefined ? [] : this.fetched(async (client) => invoicePosition(await client.getInvoice(invoice)));
      }
      case STRIPE_INVOICES_EDGE: {
        const owner: StripeListQuery = input.position.recordType === STRIPE_SUBSCRIPTION_DISPLAY_NAME ? { subscription: id } : { customer: id };
        return this.invoices(input, owner);
      }
      case STRIPE_SUBSCRIPTIONS_EDGE:
        return this.subscriptions(input, { customer: id });
      default:
        return [];
    }
  }

  /** The root's collections: every customer, invoice or subscription. */
  private async rootCollection(input: GetRelatedInput): Promise<RelatedResult[]> {
    switch (input.fieldId) {
      case STRIPE_CUSTOMERS_COLLECTION: {
        const { query, exact } = customerQueryFromWhere(input.where);
        const client = await this.client();
        return (await client.listCustomers(query, limitOf(input, exact).limit)).map(customerPosition);
      }
      case STRIPE_INVOICES_COLLECTION:
        return this.invoices(input, {});
      case STRIPE_SUBSCRIPTIONS_COLLECTION:
        return this.subscriptions(input, {});
      default:
        return [];
    }
  }

  private async invoices(input: GetRelatedInput, owner: StripeListQuery): Promise<RelatedResult[]> {
    const { query, exact } = invoiceQueryFromWhere(input.where, STRIPE_INVOICE_STATUSES);
    const client = await this.client();
    return (await client.listInvoices({ ...owner, ...query }, limitOf(input, exact).limit)).map((invoice) => invoicePosition(invoice));
  }

  private async subscriptions(input: GetRelatedInput, owner: StripeListQuery): Promise<RelatedResult[]> {
    const { query, exact } = subscriptionQueryFromWhere(input.where, STRIPE_SUBSCRIPTION_STATUSES);
    const client = await this.client();
    return (await client.listSubscriptions({ ...owner, ...query }, limitOf(input, exact).limit)).map(subscriptionPosition);
  }

  /** One record fetched by id: none when Stripe has no such record. */
  private async fetched(read: (client: StripeClient) => Promise<RelatedResult>): Promise<RelatedResult[]> {
    try {
      return [await read(await this.client())];
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return [];
      throw error;
    }
  }

  // ── 4. Events ──────────────────────────────────────────────────────────

  async listEventTypes(): Promise<EventType[]> {
    // The door tags every event it accepts, so discrimination is by tag.
    return [{ tag: STRIPE_EVENT_TAG, positionType: STRIPE_EVENT_TYPE_ID }];
  }

  async checkInbound(input: InboundCheckInput): Promise<InboundCheck> {
    return checkStripeDelivery(input, this.door);
  }
}

// ── Position minting ────────────────────────────────────────────────────────
// Every record here has a durable Stripe id, so every position is stable.
// An upcoming invoice has none yet; the event's id stands in for it.

function customerPosition(o: StripeObject): RelatedResult {
  const data = normalizeCustomer(o);
  return { position: makeStablePosition({ adapterType: STRIPE_ADAPTER_TYPE, recordType: STRIPE_CUSTOMER_DISPLAY_NAME, recordId: data.id, data }) };
}

function invoicePosition(o: StripeObject, fallbackId?: string): RelatedResult {
  const data = normalizeInvoice(o);
  const recordId = data.id !== '' ? data.id : fallbackId ?? '';
  return { position: makeStablePosition({ adapterType: STRIPE_ADAPTER_TYPE, recordType: STRIPE_INVOICE_DISPLAY_NAME, recordId, data }) };
}

function subscriptionPosition(o: StripeObject): RelatedResult {
  const data = normalizeSubscription(o);
  return { position: makeStablePosition({ adapterType: STRIPE_ADAPTER_TYPE, recordType: STRIPE_SUBSCRIPTION_DISPLAY_NAME, recordId: data.id, data }) };
}

/** An event's object along the edge that names its kind; none along another.
 *  The object is the snapshot the event carried, so this reads no API. */
function eventObject(event: StripeObject, edgeId: string): RelatedResult[] {
  const object = event['object'];
  if (!isObject(object)) return [];
  const kind = objectKind(object);
  const eventId = typeof event['id'] === 'string' ? event['id'] : '';
  if (edgeId === STRIPE_INVOICE_EDGE && kind === 'invoice') return [invoicePosition(object, `${eventId}:invoice`)];
  if (edgeId === STRIPE_SUBSCRIPTION_EDGE && kind === 'subscription') return [subscriptionPosition(object)];
  if (edgeId === STRIPE_CUSTOMER_EDGE && kind === 'customer') return [customerPosition(object)];
  return [];
}

/**
 * The LIMIT a fetch may take (`GetRelatedInput.limit`'s contract): only when
 * the hop's ORDER BY is absent or is the order Stripe already answers in
 * (newest first), and only when the WHERE was pushed exactly — n rows of a
 * wider set, narrowed afterwards, would be fewer than the n asked for.
 */
function limitOf(input: GetRelatedInput, exact: boolean): { limit?: number } {
  if (input.limit === undefined || !exact) return {};
  const ordered = input.orderBy === undefined || (input.orderBy.fieldId === 'Created' && input.orderBy.direction === 'desc');
  return ordered ? { limit: input.limit } : {};
}

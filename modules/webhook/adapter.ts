// The webhook adapter: one connection's door. A delivery is checked against
// the connection's signing (signing.ts), and its JSON body becomes one event.
// Its fields are read as the body holds them; what they are is the node the
// listen declares, which listen-fire checks the body against before any run.

import type { InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';
import type { EventType, SchemaEntryPoint, SchemaTypeDescriptor } from 'engine-contracts';
import { BaseAdapter } from 'module-kit/adapter/base';
import { accepted, inboundRequest, refused, reply } from 'module-kit';

import { DELIVERY_TAG, DELIVERY_TYPE, WEBHOOK_ADAPTER_TYPE } from './manifest';
import { verify, type Signing } from './signing';

export interface WebhookSources {
  /** The connection's signing, read off its credential per call. */
  signing(): Promise<Signing>;
  /** Now, in unix seconds. */
  now(): number;
  log: { warn(message: string): void };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class WebhookAdapter extends BaseAdapter {
  readonly adapterType = WEBHOOK_ADAPTER_TYPE;
  readonly supportedTriggers = ['webhook'] as const;

  constructor(private readonly sources: WebhookSources) {
    super();
  }

  /** The one event edge. Reading the signing first means a misconfigured
   *  credential fails `listen-fire check`, naming what to set, before any delivery. */
  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    await this.sources.signing();
    return [{ typeId: DELIVERY_TYPE, displayName: DELIVERY_TYPE, writable: false, readable: false, fires: true }];
  }

  /** A delivery has no fields of its own: the listen's `payload:` types it. */
  async describe(_typeId: string): Promise<SchemaTypeDescriptor | null> {
    return null;
  }

  async listEventTypes(): Promise<EventType[]> {
    return [{ tag: DELIVERY_TAG, positionType: DELIVERY_TYPE }];
  }

  async checkInbound(input: InboundCheckInput): Promise<InboundCheck> {
    const request = inboundRequest(input);
    if (request.method !== 'POST') return reply(405, { json: { error: 'method_not_allowed', message: 'a webhook is a POST' } });
    const signing = await this.sources.signing();
    const verdict = verify(signing, request, this.sources.now());
    if (!verdict.ok) {
      this.sources.log.warn(`webhook delivery refused: ${verdict.reason}`);
      return refused(401);
    }
    const body = request.json();
    if (!isObject(body)) {
      return reply(400, { json: { error: 'body_not_object', message: 'the body is not a JSON object: a webhook delivers one JSON object per POST' } });
    }
    const id = signing.idField === undefined ? undefined : body[signing.idField];
    const deliveryId = typeof id === 'string' && id !== '' ? id : typeof id === 'number' ? String(id) : undefined;
    return accepted([{ payload: body, tag: DELIVERY_TAG }], deliveryId === undefined ? {} : { deliveryId });
  }
}

// What the delivery receipt's tests share (deliveries.test.ts and the
// Postgres test beside it): the example with its webhook naming a delivery id
// header, movements that complete or take no event, and the signed webhook.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from './example';

export interface DeliveryDoc {
  id: string;
  subscriptionId: string;
  externalId: string | null;
  source: string;
  inline: boolean;
  replayOf: string | null;
  eventCount: number;
  runs: Array<{ id: string; status: string }>;
  events?: Array<{ external: string; event: unknown }>;
}

/** The example, its webhook declaring the header a provider's delivery id is in. */
export function receiptProject(movement?: string): string {
  const dir = project();
  const external = join(dir, 'externals/acme_crm/lf-external.yaml');
  const text = readFileSync(external, 'utf8');
  assert.match(text, /^webhook:\n/m);
  writeFileSync(external, text.replace(/^webhook:\n/m, 'webhook:\n  deliveryIdHeader: x-acme-delivery\n'));
  if (movement !== undefined) writeFileSync(join(dir, 'movements/companies.mvt'), movement);
  return dir;
}

/** Companies are welcomed and nothing more: the run completes in the request. */
export const COMPLETING = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: "Welcome \${company.Name}" }
}

listen to crm { events: ["company.created"] } fire welcome
`;

/** A listen on an event the example's webhook never produces. */
export const UPDATES_ONLY = COMPLETING.replace('company.created', 'company.updated');

export function signedWebhook(dir: string): { body: Buffer; signature: string } {
  const body = readFileSync(join(dir, 'events/webhook_body.json'));
  return { body, signature: createHmac('sha256', 'dev-acme-webhook-secret').update(body).digest('hex') };
}

export async function post(port: number, dir: string, deliveryId?: string): Promise<{ status: number; answer: { runs: unknown[]; duplicate?: boolean } }> {
  const { body, signature } = signedWebhook(dir);
  const response = await fetch(`http://127.0.0.1:${port}/hooks/acme_crm/acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-listen-fire-signature': signature, ...(deliveryId === undefined ? {} : { 'x-acme-delivery': deliveryId }) },
    body,
  });
  return { status: response.status, answer: (await response.json()) as { runs: unknown[]; duplicate?: boolean } };
}


// `@lf/stripe`: Stripe as a module. The host hands it the connection's
// credential (an API key, and the webhook endpoint's signing secret) and a
// fetch; the module builds a client per call from them, so a credential
// edited between calls is read by the next one. `listen-fire serve` serves the door at
// `/hooks/stripe/<credential>`. `ctx.config.baseUrlOverride` (the dev loop's
// fake) replaces api.stripe.com.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { StripeClient, stripeCredsParser } from './api_client';
import { StripeAdapter, type StripeClientSource } from './adapter';
import type { StripeDoorSources } from './inbound';
import { STRIPE_MANIFEST } from './manifest';

const ADD = 'listen-fire credential add --module stripe <name>';

/** The client the context's credential reaches Stripe with. */
export function stripeClientFrom(ctx: ModuleContext): StripeClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one client serves until then.
  let last: { fields: CredentialFields; client: StripeClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const parsed = stripeCredsParser.safeParse(fields);
    if (!parsed.success) throw new Error(`Stripe: the connected credential holds no API key. Add one: ${ADD}.`);
    const baseUrl = ctx.config.baseUrlOverride;
    const client = new StripeClient({ apiKey: parsed.data.apiKey, ...(baseUrl !== undefined ? { baseUrl } : {}), fetch: ctx.fetch, log: ctx.log });
    last = { fields, client };
    return client;
  };
}

/** The door's sources over a module context: the signing secret read per call. */
export function stripeDoorFrom(ctx: ModuleContext): StripeDoorSources {
  return {
    webhookSecret: async () => {
      const secret = (await ctx.credential.fields())['webhookSecret']?.trim();
      return secret === undefined || secret === '' ? undefined : secret;
    },
    now: () => Math.floor(Date.now() / 1000),
    log: ctx.log,
  };
}

export const stripeModule = defineModule({
  kind: 'adapter',
  name: '@lf/stripe',
  manifest: STRIPE_MANIFEST,
  // The stored payload: `{ apiKey, webhookSecret? }`.
  credentials: [
    {
      name: 'stripe',
      kind: 'static',
      fields: [
        { name: 'apiKey', label: 'API key (a restricted key with Read on Customers, Invoices and Subscriptions is enough: rk_live_… or rk_test_…)' },
        { name: 'webhookSecret', label: 'The webhook endpoint’s signing secret (whsec_…), for listens; empty if the program only reads', optional: true },
      ],
    },
  ],
  // Stripe issues the signing secret (at the endpoint), so listen-fire connect
  // generates none; the door reads it off the connection's credential.
  inbound: { providerKey: 'stripe', scheme: 'module', secretIssuedBy: 'provider' },
  create: (ctx) => new StripeAdapter(stripeClientFrom(ctx), stripeDoorFrom(ctx)),
});

export default stripeModule;

export * from './adapter';
export * from './api_client';
export * from './filter';
export * from './inbound';
export * from './manifest';
export * from './money';
export * from './schema';
export * from './types';

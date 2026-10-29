// `@lf/webhook`: incoming webhooks from any sender. A connection's credential
// (`listen-fire credential add --module webhook <name>`) holds how its deliveries are
// signed and the secret; `listen-fire serve` serves it at `/hooks/webhook/<name>`.

import { defineModule, type ModuleContext } from 'module-kit';

import { WebhookAdapter, type WebhookSources } from './adapter';
import { WEBHOOK_MANIFEST } from './manifest';
import { signingOf } from './signing';

/** The adapter's sources over a module context: the credential read per call. */
export function webhookSourcesFrom(ctx: ModuleContext): WebhookSources {
  return {
    signing: async () => signingOf(ctx.credential.name, await ctx.credential.fields()),
    now: () => Math.floor(Date.now() / 1000),
    log: ctx.log,
  };
}

export const webhookModule = defineModule({
  kind: 'adapter',
  name: '@lf/webhook',
  manifest: WEBHOOK_MANIFEST,
  credentials: [
    {
      name: 'webhook',
      kind: 'static',
      fields: [
        { name: 'scheme', label: 'How deliveries are signed: stripe, hmac-sha256 or none', secret: false },
        { name: 'secret', label: 'The signing secret (Stripe: the endpoint’s whsec_…; empty for none)', optional: true },
        { name: 'header', label: 'hmac-sha256 only: the header the signature is sent in (e.g. x-signature)', secret: false, optional: true },
        { name: 'encoding', label: 'hmac-sha256 only: hex or base64 (default hex)', secret: false, optional: true },
        { name: 'idField', label: 'hmac-sha256 and none: the body field holding the sender’s id for a delivery, so a retry runs once (empty: no dedupe; stripe uses id)', secret: false, optional: true },
      ],
    },
  ],
  // The sender's provider issues the secret (Stripe, at the endpoint), so listen-fire
  // connect generates none; the check reads it off the connection's credential.
  inbound: { providerKey: 'webhook', scheme: 'module', secretIssuedBy: 'provider' },
  create: (ctx) => new WebhookAdapter(webhookSourcesFrom(ctx)),
});

export default webhookModule;

export * from './adapter';
export * from './manifest';
export * from './signing';

// The webhook module's manifest: data only, so a host can list it without
// loading the adapter. The module has no types of its own: what a delivery
// carries is the node the listen declares (`payload: <Payment>`).

import type { AdapterManifest } from 'movement-engine/public/adapter';

export const WEBHOOK_ADAPTER_TYPE = 'webhook';
/** The one event a connection fires: a delivery to its URL. */
export const DELIVERY_TYPE = 'Delivery';
export const DELIVERY_TAG = 'delivery';

const HANDBOOK = `## Incoming webhooks

\`webhook\` takes a POST from any sender (Stripe, a form service, your own app). Each connection is one URL under \`listen-fire serve\`, \`/hooks/webhook/<credential>\`, which \`listen-fire serve\` prints when it starts. The connection's credential says how deliveries are signed. The program declares only what they carry.

\`\`\`
import { webhook, acme_crm } from adapters
import { StripeHook, acme } from credentials

stripe = connect webhook using StripeHook
crm = connect acme_crm using acme

node Payment {
  id: <text>
  amount: <number>
  currency: <text | null>
}

function \`Payment Failed\`(e: <Payment>) {
  write crm-[:Company]-> { Name: "\${e.id} failed: \${e.amount}" }
}

listen to stripe { payload: <Payment> } fire \`Payment Failed\`
\`\`\`

- \`payload:\` is required. It names a node the program declares, and the event is that node: reading a field it does not declare fails \`listen-fire check\`. The movement's parameter is checked against it field by field.
- The node's fields are the body's top-level JSON keys.
- A delivery whose body does not fit the node runs nothing. A field the node requires is missing or null, or holds another kind of value. When no listen on the connection takes it, the sender is answered 400, naming the fields.
- A body that is not a JSON object is answered 400.
- \`listen-fire credential add --module webhook <name>\` asks for the scheme and the secret:
  - \`stripe\`: the endpoint's signing secret (\`whsec_…\`). The \`Stripe-Signature\` header is checked, and a signature older than 5 minutes is refused.
  - \`hmac-sha256\`: the secret, the header the sender signs in (e.g. \`x-signature\`), and \`hex\` or \`base64\`. The header holds the HMAC-SHA256 of the exact body.
  - \`none\`: unsigned. Any POST to the URL runs. Choose it only for a sender that cannot sign.
- An unsigned, mis-signed or stale delivery is answered 401 and runs nothing.
- A sender retries a delivery, and the same event runs once. \`stripe\` uses the body's \`id\`. The other schemes use the credential's optional \`idField\`, a top-level body field; without it nothing is deduplicated.`;

export const WEBHOOK_MANIFEST: AdapterManifest = {
  adapterType: WEBHOOK_ADAPTER_TYPE,
  displayName: 'Webhook',
  description:
    'Incoming webhooks from any sender. Each connection is one signed URL; its credential holds the signing scheme (Stripe, an HMAC-SHA256 header, or none) and secret, and the listen declares the type its events carry.',
  handbookSection: { title: 'Incoming webhooks', content: HANDBOOK },
  supportedTriggers: ['webhook'],
  listenConfig: [{ key: 'payload', required: true, format: 'type' }],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'listEventTypes', 'checkInbound'],
};

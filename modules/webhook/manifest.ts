// The webhook module's manifest: data only, so a host can list it without
// loading the adapter. The module has no types of its own: a delivery's body
// is untyped JSON, and the listen states what it is
// (`listen to stripe-[:Requests]-><Payment> fire f`).

import type { AdapterManifest } from 'movement-engine/public/adapter';

export const WEBHOOK_ADAPTER_TYPE = 'webhook';
/** The one edge a connection has: each POST to its URL arrives on it. */
export const REQUESTS_EDGE = 'Requests';
/** What lands on it: a body the module does not describe. */
export const REQUEST_TYPE = 'Request';

const HANDBOOK = `## Incoming webhooks

\`webhook\` takes a POST from any sender (Stripe, a form service, your own app). Each connection is one URL under \`listen-fire serve\`, \`/hooks/webhook/<credential>\`, which \`listen-fire serve\` prints when it starts. The connection's credential says how deliveries are signed. The program declares only what they carry. A sender with its own module types its events for you: for Stripe, use \`@lf/stripe\`.

\`\`\`
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

listen to stripe-[:Requests]-><Payment> fire \`Payment Failed\`
\`\`\`

- Each delivery arrives on the connection's \`Requests\` edge. Its body is untyped JSON, so a listen states what it is after the traversal: \`-[:Requests]-><Payment>\` names a node the program declares. The function it fires must take what that node carries: reading a field the node does not declare fails \`listen-fire check\`.
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
    'Incoming webhooks from any sender. Each connection is one signed URL; its credential holds the signing scheme (Stripe, an HMAC-SHA256 header, or none) and secret. Each delivery arrives on its `Requests` edge, and the listen states the type its body is.',
  handbookSection: { title: 'Incoming webhooks', content: HANDBOOK },
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'checkInbound'],
  // A 0.12 `listen to stripe { payload: <Payment> }` is
  // `listen to stripe-[:Requests]-><Payment>` (`listen-fire upgrade`).
  listenSettingsBecome: { path: [REQUESTS_EDGE], aliases: ['r'], keys: { payload: { hop: 0, op: 'type' } } },
};

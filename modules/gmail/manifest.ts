// Gmail's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Gmail without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GMAIL_DRAFT_RULE, GMAIL_SEARCH_CEILING, GMAIL_WRITE_RULE } from './schema';
import { GMAIL_ADAPTER_TYPE, GMAIL_MESSAGE_RECEIVED_EVENT, GMAIL_SUBSCRIBABLE_EVENTS } from './types';

const GMAIL_HANDBOOK_CONTENT = `Gmail is ONE connected mailbox — a real Google Workspace address the connection is signed in as. It is not the forwarding address: that one only ever sees mail somebody sent to it, while this reads the inbox itself.

### running when mail arrives

\`\`\`
listen to gmail { query: "from:@acme.com" } fire triage
\`\`\`

A listener fires once per message that has arrived since the last look, a minute or so behind. \`query\` is a Gmail search written exactly as you would type it into Gmail's own search box, and it narrows what is delivered; \`every\` (for example \`every: 5m\`) overrides the one-minute default. \`labels\` says which arrivals count — mail landing in the inbox unless you say otherwise. Write \`labels: ["INBOX", "SPAM"]\` when mail you must not miss can land in Spam, such as cold inbound. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Messages\` when you want history.

### running when a message is labelled

\`\`\`
listen to gmail { events: ["label_added"], labels: ["Deals"] } fire file_deal

function file_deal(msg: <gmail-[:Message]->>) {
  which = msg.\`Added Label\`
}
\`\`\`

\`label_added\` fires once per message and label when one of the listen's \`labels\` is added to a message already in the mailbox — a person filing mail, or a filter doing it later. It delivers the message, with \`Added Label\` set to the id of the label added. Name a user label as you see it in Gmail (\`"Deals"\`) or by its id; a label the mailbox does not have fails the listener, naming the ones it has. With NO \`labels\`, \`label_added\` fires for any of the mailbox's own labels and never for Gmail's (inbox, unread, starred, important, sent, draft, spam, trash, chat, the category tabs) — those change as mail is read and filed. \`query\` narrows these too. A message ARRIVING with the label is \`message_received\`, not this; listen for both with \`events: ["message_received", "label_added"]\`. Removing a label and adding it again does not fire twice. After a long quiet spell (Gmail forgets the mark after about a week) the labels added in the gap are skipped, never delivered late as new.

### reading the message

\`\`\`
function triage(msg: <gmail-[:Message]->>) {
  who  = msg.From
  what = msg.Body
}
\`\`\`

\`Body\` is the one to reach for: it is the plain text, derived from the HTML when the message carried only HTML. \`Plain Body\` and \`HTML Body\` are there when you need the alternative that actually arrived. \`From\` is the whole header, display name included; \`To\` and \`Cc\` are lists of addresses. \`Labels\` are Gmail's label ids — \`INBOX\`, \`UNREAD\` and the rest in capitals, a user label by the id Gmail gave it (\`Label_12\`). A listener's \`labels\` also take a user label by its name.

### searching the mailbox

\`\`\`
recent = gmail-[m:Messages WHERE m.From CONTAINS "acme.com" AND m.Date WITHIN 7d]->
\`\`\`

\`Subject\`, \`From\`, \`To\`, \`Cc\`, \`Labels\`, \`Date\` and \`Body\` reach Gmail's own search; everything else is applied after the fetch, so the result is the same either way and only the amount fetched changes. A walk stops at ${GMAIL_SEARCH_CEILING} messages, because every message costs its own request — narrow it or give it a \`LIMIT\` rather than expecting the whole mailbox. Gmail answers newest first, so \`ORDER BY Date DESC LIMIT n\` costs n requests; any other \`ORDER BY\` fetches up to ${GMAIL_SEARCH_CEILING} and sorts them here.

### attachments

\`\`\`
msg-[a:Attachments]-> { … a.File … }
\`\`\`

Listing them is free — the names, types and sizes ride the message. Only reading \`File\` fetches bytes, so a message whose files nobody opens costs nothing. \`Has Attachments\` answers "are there any" without a walk.

### sending and replying

\`\`\`
write mail-[:Messages]-> {
  To: ["rita@acme.com"]
  Subject: "Your Q3 figures"
  Body: "Attached, as promised."
  Files: [doc]
}
\`\`\`

\`\`\`
write msg-[:Replies]-> { Body: "Got it — looking now." }
\`\`\`

${GMAIL_WRITE_RULE} So a reply names only what it says: it answers whoever sent the message it hangs off, it carries that subject with \`Re:\` in front, and Gmail files it in the same conversation. Override \`To\`, \`Cc\` or \`Subject\` on a reply when you mean something other than the obvious, and reach for \`HTML Body\` beside \`Body\` when the message needs formatting — both go out, and a reader that cannot show HTML still sees the text. \`Files\` takes a list of file values the run already holds; the files on a message you RECEIVED are on its \`Attachments\` edge instead.

Mail always leaves as the connected mailbox — \`From\` is not writable, because that address is the only one this deployment is allowed to be.

### drafts

\`\`\`
draft = write mail-[:Drafts]-> { To: ["rita@acme.com"], Subject: "Your Q3 figures", Body: "For Henry to check." }
\`\`\`

\`\`\`
reply = write msg-[:Drafts]-> { Body: "Looking now." }
\`\`\`

${GMAIL_DRAFT_RULE} A draft takes the fields a send does, \`Files\` included, and needs none of them. The write hands back \`Id\`, \`Message Id\` and \`Thread Id\`. A mailbox signed in without drafts refuses the write and says how to sign in again with them.

### what this connection cannot do

It reads mail, sends mail and keeps drafts. It can NEVER label, archive, delete or mark as read — the scopes it holds are read, send and (where enabled) compose, so those are not features waiting to be built but things the mailbox has not granted. Say so rather than working around it. Arrival and a label being added are the only events; nothing fires on an edit, on a label removed, or on mail this mailbox sends. Reading always works; SENDING works only where the installation enabled it, and DRAFTS only where the mailbox was signed in with drafts enabled; a mailbox without either refuses that write saying so, with reads unaffected — so a write failing never means the mailbox is disconnected. An installation may also limit which addresses can be connected at all.`;

/**
 * Static manifest. A polled source AND a target: `createRecord` sends as the
 * mailbox, along the root's `Messages` edge for new mail and along a message's
 * `Replies` edge for a reply, and keeps a Draft along either's `Drafts` edge.
 */
export const GMAIL_MANIFEST: AdapterManifest = {
  adapterType: GMAIL_ADAPTER_TYPE,
  displayName: 'Gmail',
  website: 'https://mail.google.com',
  category: 'Email',
  description:
    'One Google Workspace mailbox, read and written by automations. Run when ' +
    'mail arrives or a message is labelled, search the inbox, read a message ' +
    'with its attachments, send or reply as the mailbox, and leave drafts. ' +
    'Connected by signing in as that mailbox, so the connection reaches it and ' +
    'no other address; sending is available only where the installation ' +
    'enabled it, and drafts only where the sign-in enabled them.',
  authoringHints:
    'Gmail reads, sends and keeps drafts, and does nothing else: no labelling, ' +
    'archiving or deleting at all — those scopes were never granted. Reading ' +
    'always works; a mailbox whose installation did not enable sending refuses ' +
    'a send outright and says so, and that never means reads are broken too. ' +
    `${GMAIL_DRAFT_RULE} ` +
    'Read `Body` ' +
    'for what a message says; `Plain Body` and `HTML Body` are the alternatives ' +
    `as they arrived. ${GMAIL_WRITE_RULE} A send sets \`To\`, \`Subject\` and ` +
    '`Body`; a reply needs only a body. Subject, From, To, Cc, Labels, Date and ' +
    'Body reach Gmail’s own search; a walk with no WHERE stops at ' +
    `${GMAIL_SEARCH_CEILING} messages, since each one costs a request. A ` +
    'listener’s `query` option is a Gmail search string written exactly as ' +
    'in Gmail’s search box; its `labels` option (Gmail labels by name or id, default ' +
    '`["INBOX"]`) says which arrivals count, so add `"SPAM"` when mail that ' +
    'must not be missed can land in Spam. `events: ["label_added"]` fires ' +
    'instead when one of those labels is added to a message already there, ' +
    'once per message and label, with `Added Label` set; with no `labels` it ' +
    'counts the mailbox’s own labels only, never Gmail’s system ones. The first poll ' +
    'delivers nothing.',
  handbookSection: {
    title: 'Gmail: one connected mailbox',
    content: GMAIL_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Two kinds. `message_received` (the default) fires once per message that ' +
    'has ARRIVED in the mailbox since the last poll, about a minute behind, ' +
    'narrowed by the `query` listen option (a Gmail search string). It reads ' +
    'mail arriving in the INBOX by default — widen with the `labels` listen ' +
    'option (e.g. `labels: ["INBOX", "SPAM"]` to include Spam). `label_added` ' +
    '(`events: ["label_added"]`) fires once per message and label when one of ' +
    'the `labels` is added to a message already in the mailbox, delivering the ' +
    'message with `Added Label` set; with no `labels` it counts any user ' +
    'label, never a Gmail system one. The first poll sets the mark and emits ' +
    'nothing, so going live never replays the back catalogue; after Gmail ' +
    'forgets the mark (about a quiet week) label additions in the gap are ' +
    'skipped, never delivered late. Nothing fires on an edit, a label removed, ' +
    'or mail this mailbox SENDS.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'resolveFileRef', 'createRecord',
  ],
  requiredCredentialType: 'GOOGLE_GMAIL',
  // `events` is projected from `subscribableEvents` — Gmail has no webhook to
  // subscribe to, but the value is what types the listened parameter.
  subscribableEvents: [...GMAIL_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [GMAIL_MESSAGE_RECEIVED_EVENT],
  listenConfig: [
    { key: 'query', required: false },
    { key: 'labels', required: false, format: 'strings' },
    { key: 'pollIntervalSeconds', required: false },
  ],
  // No `triggerKinds`: the slug self-aliases, and the uppercase `GMAIL` kind is
  // already claimed by the inbound-email adapter for forwarded mail. Trigger
  // rows for this adapter carry the slug, as every polled source's do.
  vocabulary: {
    // The envelope's flap — an M laid over a rectangle, which is the mark
    // everybody reads as mail.
    icon: {
      d: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 3.2V17h16V8.2l-8 5.3-8-5.3z',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [
        { template: 'When a message arrives matching `{query}`' },
        { template: 'When a message arrives in the mailbox' },
      ],
      label_added: [{ template: 'When a message is labelled' }],
    },
  },
};

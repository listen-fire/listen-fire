// Gmail's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Gmail without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GMAIL_DRAFT_RULE, GMAIL_SEARCH_CEILING, GMAIL_WRITE_RULE } from './schema';
import {
  GMAIL_ADAPTER_TYPE,
  GMAIL_LABELINGS_COLLECTION,
  GMAIL_MESSAGES_COLLECTION,
  GMAIL_MESSAGE_DISPLAY_NAME,
  GMAIL_QUERY_FIELD,
} from './types';

const GMAIL_HANDBOOK_CONTENT = `Gmail is ONE connected mailbox — a real Google Workspace address the connection is signed in as. It is not the forwarding address: that one only ever sees mail somebody sent to it, while this reads the inbox itself.

### running when mail arrives

\`\`\`
listen to gmail-[m:Messages WHERE m.Labels CONTAINS "INBOX" AND m.Query == "from:@acme.com"]-> fire triage
\`\`\`

A listen on \`Messages\` fires once per message added to the mailbox since the last look, a minute or so behind (\`pollEvery\` in lf.yaml changes the minute for the connection). Every message counts, the mail this mailbox sends and its drafts too, so say which: \`m.Labels CONTAINS "INBOX"\` is mail that arrived in the inbox, and \`m.Labels CONTAINS "INBOX" OR m.Labels CONTAINS "SPAM"\` takes Spam too, for mail you must not miss such as cold inbound. \`Query\` is a Gmail search written exactly as you would type it into Gmail's own search box; it is compared with \`==\` only. Any other field narrows too (\`m.Subject CONTAINS "invoice"\`). Listens on one connection with the same WHERE share one poll. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Messages\` when you want history.

### running when a message is labelled

\`\`\`
listen to gmail-[l:Labelings WHERE l.Label == "Deals"]-> fire file_deal

function file_deal(l: <gmail-[:Labelings]->>) {
  msg = only(l-[:Message]->)
  who = l.From
}
\`\`\`

A listen on \`Labelings\` fires once each time a label is added to a message already in the mailbox — a person filing mail, or a filter doing it later. A labeling carries the label added (\`Label\`, its id) and the message's fields; walk \`Message\` for its attachments or to reply. Name a user label as you see it in Gmail (\`"Deals"\`) or by its id; a label the mailbox does not have fails the listen, naming the ones it has. \`\`l.\`Label Type\` == "user"\`\` takes any of the mailbox's own labels and none of Gmail's (inbox, unread, starred, important, sent, draft, spam, trash, chat, the category tabs), which change as mail is read and filed. \`Query\` narrows these too. A message ARRIVING with the label is on \`Messages\`, not this. A label removed and added again fires again. After a long quiet spell (Gmail forgets the mark after about a week) the labels added in the gap are skipped, never delivered late as new.

### reading the message

\`\`\`
function triage(msg: <gmail-[:Message]->>) {
  who  = msg.From
  what = msg.Body
}
\`\`\`

\`Body\` is the one to reach for: it is the plain text, derived from the HTML when the message carried only HTML. \`Plain Body\` and \`HTML Body\` are there when you need the alternative that actually arrived. \`From\` is the whole header, display name included; \`To\` and \`Cc\` are lists of addresses. \`Labels\` are Gmail's label ids — \`INBOX\`, \`UNREAD\` and the rest in capitals, a user label by the id Gmail gave it (\`Label_12\`). A listen's \`m.Labels CONTAINS\` also takes a user label by its name.

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

It reads mail, sends mail and keeps drafts. It can NEVER label, archive, delete or mark as read — the scopes it holds are read, send and (where enabled) compose, so those are not features waiting to be built but things the mailbox has not granted. Say so rather than working around it. A message added and a label being added are the only arrivals; nothing fires on an edit or on a label removed. Reading always works; SENDING works only where the installation enabled it, and DRAFTS only where the mailbox was signed in with drafts enabled; a mailbox without either refuses that write saying so, with reads unaffected — so a write failing never means the mailbox is disconnected. An installation may also limit which addresses can be connected at all.`;

/** What a 0.12 listen hearing mail arrive becomes. */
const MESSAGES_BECOME = {
  path: [GMAIL_MESSAGES_COLLECTION],
  aliases: ['m'],
  paramFrom: GMAIL_MESSAGE_DISPLAY_NAME,
  keys: {
    query: { hop: 0, field: GMAIL_QUERY_FIELD, op: 'eq' as const },
    labels: { hop: 0, field: 'Labels', op: 'contains' as const, absent: 'INBOX' },
  },
};

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
    `${GMAIL_SEARCH_CEILING} messages, since each one costs a request. Listen ` +
    'on `Messages` for mail added to the mailbox, narrowed by ' +
    '`m.Labels CONTAINS "INBOX"` (sent mail and drafts are added too; add ' +
    '`OR m.Labels CONTAINS "SPAM"` when mail that must not be missed can land ' +
    'in Spam) and by `m.Query == "…"`, a Gmail search string written exactly as ' +
    'in Gmail’s search box. Listen on `Labelings` when a label is added to a ' +
    'message already there: `l.Label == "Deals"` (a label by name or id) or ' +
    '``l.`Label Type` == "user"`` for any of the mailbox’s own; walk its ' +
    '`Message` for attachments. The first poll delivers nothing.',
  handbookSection: {
    title: 'Gmail: one connected mailbox',
    content: GMAIL_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Two edges, polled every minute. `Messages` fires once per message added ' +
    'to the mailbox since the last poll (sent mail and drafts too, so narrow ' +
    'by `Labels CONTAINS "INBOX"`), narrowed by `Query` (a Gmail search ' +
    'string) and any field. `Labelings` fires once each time a label is added ' +
    'to a message already in the mailbox, with the label in `Label` and the ' +
    'message’s fields; `Label Type == "user"` keeps the mailbox’s own labels. ' +
    'The first poll sets the mark and emits nothing, so going live never ' +
    'replays the back catalogue; after Gmail forgets the mark (about a quiet ' +
    'week) label additions in the gap are skipped, never delivered late. ' +
    'Nothing fires on an edit or a label removed.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'resolveFileRef', 'createRecord',
  ],
  requiredCredentialType: 'GOOGLE_GMAIL',
  // A 0.12 `listen to mail { query, labels }` is
  // `listen to mail-[m:Messages WHERE m.Query == … AND m.Labels CONTAINS …]->`,
  // the inbox when it named no labels; one naming `events: ["label_added"]`
  // is a listen on `Labelings`, the mailbox's own labels when it named none
  // (`listen-fire upgrade`).
  listenSettingsBecome: {
    ...MESSAGES_BECOME,
    byEvent: {
      message_received: MESSAGES_BECOME,
      label_added: {
        path: [GMAIL_LABELINGS_COLLECTION],
        aliases: ['l'],
        paramFrom: GMAIL_MESSAGE_DISPLAY_NAME,
        keys: {
          query: { hop: 0, field: GMAIL_QUERY_FIELD, op: 'eq' },
          labels: { hop: 0, field: 'Label', op: 'in', absent: 'user', absentField: 'Label Type' },
        },
      },
    },
  },
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
      default: [{ template: 'When a message arrives in the mailbox' }],
    },
  },
};

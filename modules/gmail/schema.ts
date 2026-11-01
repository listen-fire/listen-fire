// The Gmail type graph: the entry surface and every type descriptor.
//
// Rule 0 (adapters/CLAUDE.md): the shape follows the NATURAL graph, not the
// API. A mailbox holds MESSAGES, and a message holds FILES — that is the whole
// of it. Gmail's threads are not a node here: a thread carries no facts of its
// own beyond its messages, and the thread id on the message is everything a
// reply needs (rule 1). Labels are a field on the message rather than a type,
// because this connector can read them and can never set one. A DRAFT is its
// own type, written and never read: it has an id of its own beside its
// message's, and it exists for a person to finish.
//
// Everything here is STATIC — no credential, no network — so `describe` is free
// and the walk hydrates every target rather than stubbing.

import type { EdgeCapability } from 'engine-contracts/expression/expression';
import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaTypeDescriptor } from 'movement-engine/public/catalog';

import { META_RECORD_TYPE } from 'movement-engine/public/catalog';
import {
  GMAIL_ATTACHMENT_DISPLAY_NAME,
  GMAIL_ATTACHMENT_TYPE_ID,
  GMAIL_MAILBOX_DISPLAY_NAME,
  GMAIL_DRAFTS_COLLECTION,
  GMAIL_DRAFT_DISPLAY_NAME,
  GMAIL_DRAFT_TYPE_ID,
  GMAIL_LABELINGS_COLLECTION,
  GMAIL_LABELING_DISPLAY_NAME,
  GMAIL_LABELING_MESSAGE_EDGE,
  GMAIL_LABELING_MESSAGE_EDGE_NAME,
  GMAIL_LABELING_TYPE_ID,
  GMAIL_MAILBOX_TYPE_ID,
  GMAIL_MESSAGES_COLLECTION,
  GMAIL_MESSAGE_ATTACHMENTS_EDGE,
  GMAIL_MESSAGE_ATTACHMENTS_EDGE_NAME,
  GMAIL_MESSAGE_DISPLAY_NAME,
  GMAIL_MESSAGE_DRAFTS_EDGE,
  GMAIL_MESSAGE_DRAFTS_EDGE_NAME,
  GMAIL_MESSAGE_FILES_FIELD,
  GMAIL_MESSAGE_FILES_FIELD_NAME,
  GMAIL_MESSAGE_REPLIES_EDGE,
  GMAIL_MESSAGE_REPLIES_EDGE_NAME,
  GMAIL_MESSAGE_TYPE_ID,
  GMAIL_POLL_EVERY_SECONDS,
  GMAIL_QUERY_FIELD,
  GMAIL_QUERY_FIELD_ID,
  GMAIL_QUERY_TYPE,
} from './types';

/**
 * The rule, in one sentence, wherever an author might meet it.
 *
 * Reply is not a mode a field turns on: it is WHERE the write goes. That keeps
 * the checker in charge of the difference — a reply written at the root cannot
 * typecheck — instead of leaving a half-set pair of fields to fail in a run.
 */
export const GMAIL_WRITE_RULE =
  'A Message written along the mailbox’s `Messages` edge is a NEW message; a ' +
  'Message written along another message’s `Replies` edge is a reply, and its ' +
  'thread, its `Re:` subject and its reply headers all come from that parent ' +
  'rather than from fields.';

/** Drafts, in one sentence, wherever an author meets them. */
export const GMAIL_DRAFT_RULE =
  'A Draft written along the mailbox’s `Drafts` edge is kept unsent for a ' +
  'person to finish; along a message’s `Drafts` edge it is a reply kept ' +
  'unsent, threaded as a reply is. Drafts work only where the mailbox was ' +
  'signed in with drafts enabled (the `gmail_drafts` credential).';

/** How many messages one unbounded `Messages` walk will fetch. Every message
 *  costs its own request, so the ceiling is low on purpose — an author who
 *  wants more narrows the search rather than paging the mailbox. */
export const GMAIL_SEARCH_CEILING = 100;

/** The field Gmail's search is sorted by — named once, because the mailbox
 *  search declares its natural order by it. */
const DATE_FIELD_NAME = 'Date';

const MESSAGES_DESCRIPTION =
  'Messages in the connected mailbox, newest first. A WHERE on `Subject`, ' +
  '`From`, `To`, `Cc`, `Labels`, `Date` or `Body` becomes a Gmail search, so a narrow ' +
  'walk costs one search rather than a scan; anything else is applied after the ' +
  `fetch. A walk stops at ${GMAIL_SEARCH_CEILING} messages — narrow it or give ` +
  'it a LIMIT rather than expecting the whole mailbox. Every message is its own ' +
  'request, so `ORDER BY Date DESC LIMIT n` — the order Gmail already answers ' +
  `in — costs n requests; any other ORDER BY fetches up to ${GMAIL_SEARCH_CEILING} ` +
  'and sorts them here. A listen on `Messages` is told about each message ' +
  'added to the mailbox from go-live on (sent mail and drafts too: narrow it by ' +
  '`Labels CONTAINS "INBOX"` for mail that arrived).';

const LABELINGS_DESCRIPTION =
  'Each label added to a message already in the mailbox — a person filing ' +
  'mail, or a filter doing it later: what a listen hears, never a list to read. ' +
  'Narrow it by `Label` (a label by its name or id) or `Label Type` ' +
  '(`"user"` for the mailbox’s own labels), and by `Query`.';

/**
 * The root collection, served by Gmail's own search. The WHERE reaches the `q`
 * query and the LIMIT reaches the page size. Gmail takes no sort and always
 * answers newest first, so `Date` descending is satisfied at the source (the
 * LIMIT rides with it) and every other order is `bounded`: fetched up to the
 * ceiling and sorted by the engine.
 */
/** A listen's WHERE on `Labelings` reaches the poll: the labels it names are
 *  the history read. */
const LABELINGS_TAKEN = { filter: 'native', supportsLimit: false } satisfies EdgeCapability;

export const GMAIL_MAILBOX_SEARCH = {
  filter: 'native',
  order: 'bounded',
  supportsLimit: true,
  naturalOrder: { field: DATE_FIELD_NAME, direction: 'desc' },
} satisfies EdgeCapability;

/**
 * The entry surface. `Attachment` is reachable ONLY through its message, so it
 * publishes `readable: false`: the root cannot enumerate files, and a root
 * collection would be a read that could only ever return nothing. The entry
 * stays published so the name resolver and `describe` still know the type.
 */
export function gmailEntryPoints(): SchemaEntryPoint[] {
  return [
    {
      typeId: GMAIL_MESSAGE_TYPE_ID,
      displayName: GMAIL_MESSAGE_DISPLAY_NAME,
      // The root write IS the send: `write mail-[:Messages]-> { … }` posts a new
      // message as the mailbox. A reply is the same type along a different edge
      // (`GMAIL_WRITE_RULE`).
      writable: true,
      readable: true,
      collectionName: GMAIL_MESSAGES_COLLECTION,
      description: MESSAGES_DESCRIPTION,
      // One edge, two promises: the mailbox can be searched, and each message
      // added to it arrives on it.
      listenable: true,
      capability: GMAIL_MAILBOX_SEARCH,
      delivery: 'polled',
      pollEverySeconds: GMAIL_POLL_EVERY_SECONDS,
      cursor: true,
      identity: 'Message Id',
    },
    {
      typeId: GMAIL_LABELING_TYPE_ID,
      displayName: GMAIL_LABELING_DISPLAY_NAME,
      writable: false,
      readable: false,
      collectionName: GMAIL_LABELINGS_COLLECTION,
      description: LABELINGS_DESCRIPTION,
      listenable: true,
      capability: LABELINGS_TAKEN,
      delivery: 'polled',
      pollEverySeconds: GMAIL_POLL_EVERY_SECONDS,
      cursor: true,
      identity: 'Id',
    },
    {
      typeId: GMAIL_DRAFT_TYPE_ID,
      displayName: GMAIL_DRAFT_DISPLAY_NAME,
      writable: true,
      readable: false,
      collectionName: GMAIL_DRAFTS_COLLECTION,
      description: GMAIL_DRAFT_RULE,
    },
    {
      typeId: GMAIL_ATTACHMENT_TYPE_ID,
      displayName: GMAIL_ATTACHMENT_DISPLAY_NAME,
      writable: false,
      readable: false,
    },
  ];
}

/** The mailbox meta node — what this connection IS, and the edges leaving it.
 *  The one thing no `describe` can answer, so the adapter states it. */
export const GMAIL_ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: GMAIL_MAILBOX_DISPLAY_NAME,
  description:
    'One Google Workspace mailbox. Walk `Messages` to search it, write along ' +
    '`Messages` to send as the mailbox, listen on `Messages` to run when mail ' +
    'arrives, or on `Labelings` when a message is labelled. ' +
    GMAIL_WRITE_RULE +
    ' ' +
    GMAIL_DRAFT_RULE +
    ' Reading, sending and drafting are the whole of what this connection can ' +
    'do: no labelling, no archiving, no deleting.',
  fields: [],
  references: [
    {
      fieldId: GMAIL_MESSAGES_COLLECTION,
      targetTypeId: GMAIL_MESSAGE_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GMAIL_MESSAGES_COLLECTION,
      description: `${MESSAGES_DESCRIPTION} Writing along this edge SENDS a new message as the mailbox.`,
      // Gmail hands a search back newest first and every page keeps that order,
      // so a fold over the walk has a real sequence to fold over.
      sequenced: 'chronological',
      writable: true,
      // Nothing to link: a mail already in the mailbox cannot be "added" to it.
      linkable: false,
      capability: GMAIL_MAILBOX_SEARCH,
      listenable: true,
    },
    {
      fieldId: GMAIL_DRAFTS_COLLECTION,
      targetTypeId: GMAIL_DRAFT_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GMAIL_DRAFTS_COLLECTION,
      writable: true,
      // Write-only: this connection keeps drafts for a person, it does not
      // read them back.
      readable: false,
      linkable: false,
      description: `Write here to keep a new message unsent. ${GMAIL_DRAFT_RULE}`,
    },
    {
      fieldId: GMAIL_LABELINGS_COLLECTION,
      targetTypeId: GMAIL_LABELING_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GMAIL_LABELINGS_COLLECTION,
      description: LABELINGS_DESCRIPTION,
      readable: false,
      writable: false,
      linkable: false,
      listenable: true,
      capability: LABELINGS_TAKEN,
    },
  ],
};

/** The search a listen narrows by: Gmail parses it, so it is compared with
 *  `==` only. An arrival carries the search its poll made, and a walk's
 *  record the search it was found by, so a comparison the engine makes agrees
 *  with the one Gmail made. */
const QUERY_FIELD: SchemaFieldDescriptor = {
  fieldId: GMAIL_QUERY_FIELD_ID,
  displayName: GMAIL_QUERY_FIELD,
  kind: 'owned',
  owned: { name: GMAIL_QUERY_TYPE },
  writable: false,
  required: false,
  capability: { filterOperators: ['eq'] },
  description:
    'A Gmail search written exactly as in Gmail’s own search box (`m.Query == "from:@acme.com has:attachment"`): ' +
    'what is searched for comes back. Compared with `==` only. Read, it is the search the message was found by ' +
    '(what its listen or walk compared it with), and nothing on a message found otherwise.',
};

const MESSAGE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GMAIL_MESSAGE_TYPE_ID,
  displayName: GMAIL_MESSAGE_DISPLAY_NAME,
  description:
    'One message in the mailbox — who sent it, what it says, and what came ' +
    'attached. Read `Body` for what it says without caring which format ' +
    `arrived. ${GMAIL_WRITE_RULE} A send sets \`To\`, \`Subject\`, \`Body\` ` +
    '(and `HTML Body` / `Files` when they apply); a reply needs nothing but a ' +
    'body.',
  fields: [
    { fieldId: 'id', displayName: 'Message Id', kind: 'string', writable: false, required: true, description: "Gmail's own id for the message." },
    { fieldId: 'threadId', displayName: 'Thread Id', kind: 'string', writable: false, required: false, description: 'The conversation this message belongs to. Read-only: a reply joins a conversation by being written along that message’s `Replies` edge, never by naming its thread.' },
    { fieldId: 'subject', displayName: 'Subject', kind: 'string', writable: true, required: false, description: 'On a read, the subject line; a WHERE reaches Gmail as a `subject:` search — `=` and `contains` alike, since Gmail matches words rather than whole strings, and the engine then narrows `=` to an exact match. On a send, the subject to use; a reply that leaves it unset gets the parent’s subject with `Re:` in front.', capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'from', displayName: 'From', kind: 'string', writable: false, required: false, description: 'The "From" header whole, display name included ("Rita Okoye" <rita@…>). Read-only on a send too: mail always leaves as the connected mailbox, which is the only address this deployment is allowed to be. A WHERE reaches Gmail as a `from:` search.', capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'to', displayName: 'To', kind: 'string', cardinality: 'many', writable: true, required: false, description: 'The addresses on the "To" header — a list, each either a bare address or `"Name" <address>`. Required on a new message; a reply that leaves it unset answers whoever sent the parent. A WHERE reaches Gmail as a `to:` search.', capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'cc', displayName: 'Cc', kind: 'string', cardinality: 'many', writable: true, required: false, description: 'The addresses on the "Cc" header, written the same way as `To`. A reply does NOT inherit the parent’s Cc — copy people in deliberately. A WHERE reaches Gmail as a `cc:` search.', capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'date', displayName: DATE_FIELD_NAME, kind: 'date', writable: false, required: false, description: 'When Gmail received the message. Bounds reach the search as `after:` / `before:`, which are whole-second and inclusive over there — the engine narrows the edges.', capability: { filterOperators: ['gt', 'gte', 'lt', 'lte'], orderable: true } },
    { fieldId: 'snippet', displayName: 'Snippet', kind: 'string', writable: false, required: false, description: "Gmail's own short preview." },
    { fieldId: 'body', displayName: 'Body', kind: 'string', writable: true, uiHint: 'textarea', required: false, description: 'On a read, the normalised body — plain text, derived from the HTML when only HTML arrived; use this for "what it says", and a `contains` reaches Gmail as a word search. On a send, the plain-text body. Every send needs a `Body` or an `HTML Body`.', capability: { filterOperators: ['contains'] } },
    { fieldId: 'bodyText', displayName: 'Plain Body', kind: 'string', writable: false, required: false, description: 'The plain-text alternative exactly as it arrived, or nothing when the message was HTML only. Read-only — `Body` is what a send sets.' },
    { fieldId: 'bodyHtml', displayName: 'HTML Body', kind: 'string', writable: true, required: false, description: 'The HTML alternative. Set it alongside `Body` on a send and the message goes out as both, so a reader that cannot show HTML still sees the text.' },
    { fieldId: GMAIL_MESSAGE_FILES_FIELD, displayName: GMAIL_MESSAGE_FILES_FIELD_NAME, kind: 'file', cardinality: 'many', writable: true, readable: false, required: false, description: 'Files to attach to a message being sent — a list of file values the run already holds (an attachment read off another message, a document a movement produced). Send-side only: the files on a RECEIVED message are on its `Attachments` edge.' },
    { fieldId: 'labels', displayName: 'Labels', kind: 'string', cardinality: 'many', writable: false, required: false, description: 'Label names — a user label as the mailbox calls it (Deals), Gmail’s own in capitals (INBOX, UNREAD, IMPORTANT), in a walk and in a listen alike. A WHERE reaches the search as `label:`, and an OR of `CONTAINS` hears mail carrying any of them (`m.Labels CONTAINS "Deals" OR m.Labels CONTAINS "Hiring"`). This connection can read them and can never set one.', capability: { filterOperators: ['eq', 'in', 'contains', 'containsAny'] } },
    { fieldId: 'hasAttachments', displayName: 'Has Attachments', kind: 'boolean', writable: false, required: false, description: 'Whether walking `Attachments` would find anything — true without fetching a single byte.' },
    QUERY_FIELD,
  ],
  references: [
    {
      fieldId: GMAIL_MESSAGE_ATTACHMENTS_EDGE,
      targetTypeId: GMAIL_ATTACHMENT_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GMAIL_MESSAGE_ATTACHMENTS_EDGE_NAME,
      // Read-only: the message arrived with its files; nothing is ever created
      // along this edge.
      writable: false,
      // The MIME walk keeps the parts in the order the message carried them, so
      // an author folding the attachments gets the message's own sequence.
      sequenced: 'document',
      description:
        'Files attached to the message (zero or more). Listing them is free — ' +
        'the bytes are fetched only when `File` is read.',
    },
    {
      fieldId: GMAIL_MESSAGE_REPLIES_EDGE,
      targetTypeId: GMAIL_MESSAGE_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GMAIL_MESSAGE_REPLIES_EDGE_NAME,
      writable: true,
      // Write-only. Gmail can serve the rest of a conversation, and this
      // connector does not read one yet — saying `readable: true` would be the
      // unchecked promise `readable` exists to stop.
      readable: false,
      // A message that already exists cannot be moved into a conversation:
      // threading is decided when it is sent.
      linkable: false,
      description:
        'Write here to reply to this message inside its conversation. The ' +
        'thread, the `Re:` subject and the `In-Reply-To` / `References` ' +
        'headers all come from this parent — a reply names only what it says ' +
        '(`Body`), and may override `Subject`, `To` or `Cc`. Not readable: ' +
        'this connection sends into a conversation, it does not read one back.',
    },
    {
      fieldId: GMAIL_MESSAGE_DRAFTS_EDGE,
      targetTypeId: GMAIL_DRAFT_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GMAIL_MESSAGE_DRAFTS_EDGE_NAME,
      writable: true,
      readable: false,
      linkable: false,
      description:
        'Write here to keep a reply to this message unsent, for a person to ' +
        'finish. Threaded exactly as a reply along `Replies` is.',
    },
  ],
};

/**
 * One label added to one message: the label, and the message as it is now
 * (its fields straight off, or walk `Message` for its attachments). Every
 * addition is its own: a label removed and added again is a second one.
 */
const LABELING_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GMAIL_LABELING_TYPE_ID,
  displayName: GMAIL_LABELING_DISPLAY_NAME,
  description: LABELINGS_DESCRIPTION,
  fields: [
    { fieldId: 'labelingId', displayName: 'Id', kind: 'string', writable: false, required: true, description: 'This addition: the message, the label and the moment in the mailbox’s history it was added.' },
    { fieldId: 'label', displayName: 'Label', kind: 'string', writable: false, required: true, capability: { filterOperators: ['eq', 'in'] }, description: 'The label id that was added (INBOX, STARRED… in capitals, a user label by its id, Label_12). A listen names a user label by its name as you see it in Gmail (`l.Label == "Deals"`) or by its id; a label the mailbox does not have fails the listen, naming the ones it has.' },
    { fieldId: 'labelType', displayName: 'Label Type', kind: 'enum', enumValues: ['system', 'user'], writable: false, required: true, capability: { filterOperators: ['eq', 'in'] }, description: '`user` for the mailbox’s own labels, `system` for Gmail’s (inbox, unread, starred, important, sent, draft, spam, trash, chat, the category tabs), which change as mail is read and filed.' },
    QUERY_FIELD,
    ...MESSAGE_DESCRIPTOR.fields
      .filter((f) => f.fieldId !== GMAIL_QUERY_FIELD_ID && f.fieldId !== GMAIL_MESSAGE_FILES_FIELD)
      .map((f) => ({ ...f, writable: false })),
  ],
  references: [
    {
      fieldId: GMAIL_LABELING_MESSAGE_EDGE,
      targetTypeId: GMAIL_MESSAGE_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: GMAIL_LABELING_MESSAGE_EDGE_NAME,
      writable: false,
      linkable: false,
      description: 'The message that was labelled, whole: walk its `Attachments`, or reply along its `Replies`.',
    },
  ],
};

const DRAFT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GMAIL_DRAFT_TYPE_ID,
  displayName: GMAIL_DRAFT_DISPLAY_NAME,
  description:
    `A message kept unsent in the mailbox. ${GMAIL_DRAFT_RULE} Every field ` +
    'is optional: a person finishes the draft. The write hands back its `Id`, ' +
    '`Message Id` and `Thread Id`.',
  fields: [
    { fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: false, description: "Gmail's id for the draft (not its message's)." },
    { fieldId: 'messageId', displayName: 'Message Id', kind: 'string', writable: false, required: false, description: 'The id of the message the draft holds.' },
    { fieldId: 'threadId', displayName: 'Thread Id', kind: 'string', writable: false, required: false, description: 'The conversation the draft belongs to: its parent’s, on a reply draft.' },
    { fieldId: 'to', displayName: 'To', kind: 'string', cardinality: 'many', writable: true, required: false, description: 'The addresses on the "To" header. A reply draft that leaves it unset answers whoever sent the parent.' },
    { fieldId: 'cc', displayName: 'Cc', kind: 'string', cardinality: 'many', writable: true, required: false, description: 'The addresses on the "Cc" header.' },
    { fieldId: 'subject', displayName: 'Subject', kind: 'string', writable: true, required: false, description: 'The subject line; a reply draft that leaves it unset gets the parent’s with `Re:` in front.' },
    { fieldId: 'body', displayName: 'Body', kind: 'string', writable: true, uiHint: 'textarea', required: false, description: 'The plain-text body.' },
    { fieldId: 'bodyHtml', displayName: 'HTML Body', kind: 'string', writable: true, required: false, description: 'The HTML alternative, set alongside `Body`.' },
    { fieldId: GMAIL_MESSAGE_FILES_FIELD, displayName: GMAIL_MESSAGE_FILES_FIELD_NAME, kind: 'file', cardinality: 'many', writable: true, readable: false, required: false, description: 'Files to attach — a list of file values the run already holds.' },
  ],
  references: [],
};

const ATTACHMENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GMAIL_ATTACHMENT_TYPE_ID,
  displayName: GMAIL_ATTACHMENT_DISPLAY_NAME,
  description:
    'One file on a message. Gmail serves the bytes from their own endpoint, so ' +
    'the name, type and size cost nothing and only `File` costs a fetch.',
  fields: [
    { fieldId: 'filename', displayName: 'Name', kind: 'string', writable: false, required: true },
    { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: true },
    { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, required: false, description: 'Bytes, as Gmail reports them.' },
    { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false, description: 'The bytes themselves — fetched when read, so a message whose files nobody opens costs nothing.' },
  ],
  references: [],
};

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  [GMAIL_MESSAGE_TYPE_ID]: MESSAGE_DESCRIPTOR,
  [GMAIL_DRAFT_TYPE_ID]: DRAFT_DESCRIPTOR,
  [GMAIL_LABELING_TYPE_ID]: LABELING_DESCRIPTOR,
  [GMAIL_ATTACHMENT_TYPE_ID]: ATTACHMENT_DESCRIPTOR,
};

/** The mailbox meta descriptor — the same node `edgesFrom` roots at, but
 *  addressed by type id (author-time introspection reaches it that way). */
export const GMAIL_MAILBOX_DESCRIPTOR: SchemaTypeDescriptor = {
  ...GMAIL_ROOT,
  typeId: GMAIL_MAILBOX_TYPE_ID,
};

/** `describe` over an already-resolved INTERNAL type id. Null for an id this
 *  adapter does not own. */
export function describeGmailType(typeId: string): SchemaTypeDescriptor | null {
  return DESCRIPTORS[typeId] ?? null;
}

/** The surface name of a Message field, from either spelling a hop may carry
 *  (the internal fieldId or the display name). Undefined for no such field. */
export function gmailMessageFieldName(name: string): string | undefined {
  return MESSAGE_DESCRIPTOR.fields.find((f) => f.fieldId === name || f.displayName === name)
    ?.displayName;
}

/** A record's fields by the names a program reads them by, beside its own
 *  ids, as an arrival's landing carries them: the host judges a listen's
 *  WHERE by name, `getFieldValue` reads by id. */
function landingFields(descriptor: SchemaTypeDescriptor, record: Record<string, unknown>): Record<string, unknown> {
  const named = descriptor.fields.filter((f) => Reflect.has(record, f.fieldId)).map((f) => [f.displayName, Reflect.get(record, f.fieldId)]);
  return { ...record, ...Object.fromEntries(named) };
}

export function messageLandingFields(record: Record<string, unknown>): Record<string, unknown> {
  return landingFields(MESSAGE_DESCRIPTOR, record);
}

export function labelingLandingFields(record: Record<string, unknown>): Record<string, unknown> {
  return landingFields(LABELING_DESCRIPTOR, record);
}

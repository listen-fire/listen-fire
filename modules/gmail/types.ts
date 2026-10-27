// Gmail adapter — the names and ids the rest of the package shares.
//
// The ONE rule (adapters/base.ts): a position's `recordType` is the pretty
// DISPLAY NAME; the `gmail:*` typeIds below are this adapter's private currency
// and never ride a position.

export const GMAIL_ADAPTER_TYPE = 'gmail';

/** The mailbox meta node a movement obtains by constructing the adapter. */
export const GMAIL_MAILBOX_TYPE_ID = 'gmail:mailbox';
export const GMAIL_MAILBOX_DISPLAY_NAME = 'Gmail';

export const GMAIL_MESSAGE_TYPE_ID = 'gmail:message';
export const GMAIL_MESSAGE_DISPLAY_NAME = 'Message';

/** A message the mailbox holds unsent, for a person to finish and send. Its
 *  own type, because a draft has its own id beside its message's. */
export const GMAIL_DRAFT_TYPE_ID = 'gmail:draft';
export const GMAIL_DRAFT_DISPLAY_NAME = 'Draft';

export const GMAIL_ATTACHMENT_TYPE_ID = 'gmail:attachment';
export const GMAIL_ATTACHMENT_DISPLAY_NAME = 'Attachment';

/** The root collection an author searches the mailbox through. */
export const GMAIL_MESSAGES_COLLECTION = 'Messages';

/** The root edge a new draft is written along. Write-only: drafts are made
 *  here for a person to send, never read back. */
export const GMAIL_DRAFTS_COLLECTION = 'Drafts';

// Rule 5: an edge never carries the system name — the instance already says
// which system you are in.
export const GMAIL_MESSAGE_ATTACHMENTS_EDGE = 'message_attachments';
export const GMAIL_MESSAGE_ATTACHMENTS_EDGE_NAME = 'Attachments';

/**
 * The reply edge: a Message written along ANOTHER message's `Replies` lands in
 * that message's conversation. It is write-only — the thread, the `Re:` subject
 * and the reply headers are derived from the parent, so a reply is a write that
 * names nothing about where it goes, exactly as a Slack thread reply is.
 */
export const GMAIL_MESSAGE_REPLIES_EDGE = 'message_replies';
export const GMAIL_MESSAGE_REPLIES_EDGE_NAME = 'Replies';

/** The reply-draft edge: a Draft written along a message's `Drafts` is a
 *  reply to it left unsent, threaded exactly as a reply along `Replies` is. */
export const GMAIL_MESSAGE_DRAFTS_EDGE = 'message_drafts';
export const GMAIL_MESSAGE_DRAFTS_EDGE_NAME = 'Drafts';

/** The send-side file field. It cannot be called `Attachments`: that name
 *  already belongs to the READ edge on the same type, and one name for two
 *  things on one node is a collision waiting to be discovered by an author. */
export const GMAIL_MESSAGE_FILES_FIELD = 'files';
export const GMAIL_MESSAGE_FILES_FIELD_NAME = 'Files';

// ── The `events:` vocabulary ────────────────────────────────────────────────
// Two kinds: a message that has arrived since the last look, and a label added
// to a message already in the mailbox (a person filing mail is how a mailbox
// hands work on). Gmail's history offers more (labels removed, messages
// deleted), and nobody has asked to run on those.

export const GMAIL_MESSAGE_RECEIVED_EVENT = 'message_received';
export const GMAIL_LABEL_ADDED_EVENT = 'label_added';

export const GMAIL_SUBSCRIBABLE_EVENTS = [GMAIL_MESSAGE_RECEIVED_EVENT, GMAIL_LABEL_ADDED_EVENT] as const;
export type GmailEventKind = (typeof GMAIL_SUBSCRIBABLE_EVENTS)[number];

/** The discriminators the polled events carry. */
export const GMAIL_MESSAGE_EVENT_TAG = 'gmail:message_received';
export const GMAIL_LABEL_EVENT_TAG = 'gmail:label_added';

/** The Message field a `label_added` event fills: the label that was added. */
export const GMAIL_ADDED_LABEL_FIELD = 'addedLabel';

/**
 * The opaque checkpoint the PollSource persists.
 *
 * TWO marks, because Gmail's own one is perishable: `historyId` is the change
 * marker a normal poll advances from, and `lastSeenAt` is the fallback for when
 * Gmail has dropped it (about a week of inactivity is enough). Without the
 * second, an expired marker would be a listener that never fires again.
 * Absent ⇒ a trigger that has never polled; the first poll sets both and
 * delivers nothing.
 */
export interface GmailCheckpoint {
  /** Covers arrivals and label additions alike: Gmail's history ids are one
   *  sequence for every kind of change. */
  historyId?: string;
  /** ISO instant — the newest message already delivered, or the moment the
   *  listener went live. */
  lastSeenAt?: string;
  /**
   * Arrivals history reported that the listen's search did not yet admit.
   * Gmail's search catches up with its history only eventually, so "not
   * admitted" first means "not yet known" — each is re-checked on later ticks
   * until its grace window runs out, and only then taken to be excluded.
   */
  pending?: GmailPendingArrival[];
}

export interface GmailPendingArrival {
  id: string;
  /** ISO instant — the tick that first saw it arrive. */
  firstSeenAt: string;
}

/**
 * An attachment's identity IS the pair (message, attachment): Gmail's
 * attachment ids are scoped to their message, and the same file forwarded twice
 * would otherwise mint one node for two positions. The pair travels as one
 * string through the `externalId` and `FileRef` handle seams, encoded and
 * decoded here so no call site re-invents the separator.
 */
export function encodeAttachmentId(input: { messageId: string; attachmentId: string }): string {
  return `${input.messageId}:${input.attachmentId}`;
}

/** The inverse of {@link encodeAttachmentId}. Splits at the FIRST separator —
 *  undefined when the value is not a pair. */
export function decodeAttachmentId(
  externalId: string,
): { messageId: string; attachmentId: string } | undefined {
  const at = externalId.indexOf(':');
  if (at <= 0 || at === externalId.length - 1) return undefined;
  return { messageId: externalId.slice(0, at), attachmentId: externalId.slice(at + 1) };
}

type EmailRecipient = {
  email: string;
  username: string;
};

type Attachment = {
  filename: string;
  data: Buffer;
};

/** What the send was FOR, when the caller knows. Purely for the outbound_email
 *  ledger — no delivery behaviour depends on it, so a caller that doesn't know
 *  simply omits it and the row is logged with nulls. */
type EmailMetadata = {
  teamId?: string;
  kind?: string;
};

type SendArgs = {
  recipients: EmailRecipient[];
  sender?: EmailRecipient;
  subject: string;
  data: string | { templateName: string; params: Record<string, unknown> };
  replyToHeader?: string;
  inReplyToHeader?: string;
  attachment?: Attachment;
  cc?: EmailRecipient[];
  metadata?: EmailMetadata;
};

interface OutboundEmailMessager {
  /** False means the provider REJECTED the message. Callers must treat it as a
   *  failed send — it is not a "probably fine" signal. */
  send: (args: SendArgs) => Promise<boolean>;
}

export { OutboundEmailMessager, EmailRecipient, EmailMetadata, SendArgs };

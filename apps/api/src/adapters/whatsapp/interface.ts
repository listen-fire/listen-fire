type WhatsAppRecipient = {
  phoneNumber: string;
  displayName?: string;
};

type SendArgs = {
  recipient: WhatsAppRecipient;
  body: string;
  contentSid?: string;
};

interface OutboundWhatsAppMessager {
  send: (args: SendArgs) => Promise<boolean>;
}

export { OutboundWhatsAppMessager, WhatsAppRecipient, SendArgs };

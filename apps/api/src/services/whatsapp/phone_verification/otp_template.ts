// Builds the Meta Cloud API payload for our authentication ("OTP") template.
// The template renders a copy-code button, and Meta requires the code in the
// button parameter (sub_type 'url', index '0') as well as the body. The body
// carries two placeholders — {{1}} the code and {{2}} the app name — so both
// must be supplied or Meta rejects the send. Kept pure so the shape is locked by
// tests without touching the network. The app name a recipient sees is the one
// registered with Meta for THIS deployment, so it comes from configuration.

import { whatsappAppDisplayName } from '../../../lib/brand';

export interface OtpTemplatePayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components: Array<{
      type: 'body' | 'button';
      sub_type?: 'url';
      index?: string;
      parameters: Array<{ type: 'text'; text: string }>;
    }>;
  };
}

export function buildOtpTemplatePayload(input: {
  to: string;
  code: string;
  templateName: string;
  languageCode: string;
  appName?: string;
}): OtpTemplatePayload {
  const { to, code, templateName, languageCode, appName = whatsappAppDisplayName() } = input;
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: code },
            { type: 'text', text: appName },
          ],
        },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };
}

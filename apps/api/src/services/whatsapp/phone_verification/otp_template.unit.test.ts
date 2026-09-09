// Meta authentication ("OTP") templates deliver the code with a copy-code
// button. Unlike a plain template, the send payload must carry the code in BOTH
// the body parameter AND the button parameter, and the button is sub_type 'url'.
// This locks that shape.

import { buildOtpTemplatePayload } from './otp_template';

describe('buildOtpTemplatePayload', () => {
  const payload = buildOtpTemplatePayload({
    to: '+447700900000',
    code: '123456',
    templateName: 'verify_otp',
    languageCode: 'en_US',
  });

  it('is a whatsapp template message for the named template', () => {
    expect(payload.messaging_product).toBe('whatsapp');
    expect(payload.to).toBe('+447700900000');
    expect(payload.type).toBe('template');
    expect(payload.template.name).toBe('verify_otp');
    expect(payload.template.language.code).toBe('en_US');
  });

  it('carries the code then the app name in the two body parameters', () => {
    const body = payload.template.components.find((c) => c.type === 'body');
    expect(body?.parameters).toEqual([
      { type: 'text', text: '123456' },
      { type: 'text', text: 'Listen-Fire' },
    ]);
  });

  it('carries the code again in a copy-code (url) button at index 0', () => {
    const button = payload.template.components.find((c) => c.type === 'button');
    expect(button).toMatchObject({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '123456' }],
    });
  });
});

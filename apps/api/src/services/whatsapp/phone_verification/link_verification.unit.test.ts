import { maskPhoneNumber, whatsappLinkVerification } from './link_verification';

describe('whatsappLinkVerification', () => {
  it('defaults to sending a code', () => {
    expect(whatsappLinkVerification({})).toBe('otp');
    expect(whatsappLinkVerification({ WHATSAPP_LINK_VERIFICATION: '  ' })).toBe('otp');
  });

  it('reads each mode it offers', () => {
    expect(whatsappLinkVerification({ WHATSAPP_LINK_VERIFICATION: 'otp' })).toBe('otp');
    expect(whatsappLinkVerification({ WHATSAPP_LINK_VERIFICATION: 'trust' })).toBe('trust');
  });

  it('throws on anything else, naming the variable and both values', () => {
    expect(() => whatsappLinkVerification({ WHATSAPP_LINK_VERIFICATION: 'trusted' })).toThrow(
      "WHATSAPP_LINK_VERIFICATION='trusted' is not a WhatsApp link verification mode. " +
        'Set it to otp or trust, or leave it unset for otp.',
    );
  });
});

describe('maskPhoneNumber', () => {
  it('keeps only the last three digits', () => {
    expect(maskPhoneNumber('+447700900123')).toBe('+*********123');
  });
});

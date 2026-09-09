import {
  connectFormSpecForType,
  isKeyEntryConnectable,
} from '../connect_form_spec';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

describe('connect_form_spec', () => {
  it('renders the Granola form as a single secret apiKey field', () => {
    const spec = connectFormSpecForType(ExternalServiceType.GRANOLA);
    expect(spec).toBeDefined();
    expect(spec!.fields).toEqual([
      { name: 'apiKey', label: 'API key', secret: true, optional: false, kind: 'text' },
    ]);
  });

  it('parses a Granola key into the credentials envelope', () => {
    const spec = connectFormSpecForType(ExternalServiceType.GRANOLA)!;
    expect(spec.parse({ apiKey: ' gr-key ' })).toEqual({ apiKey: 'gr-key' });
  });

  it('rejects a missing required key', () => {
    const spec = connectFormSpecForType(ExternalServiceType.GRANOLA)!;
    expect(() => spec.parse({ apiKey: '' })).toThrow();
  });

  it('drops blank optional fields (Affinity baseUrl) rather than failing', () => {
    const spec = connectFormSpecForType(ExternalServiceType.AFFINITY)!;
    expect(spec.parse({ apiKey: 'aff-key', baseUrl: '' })).toEqual({ apiKey: 'aff-key' });
  });

  it('keeps a provided optional field (Affinity baseUrl)', () => {
    const spec = connectFormSpecForType(ExternalServiceType.AFFINITY)!;
    expect(spec.parse({ apiKey: 'aff-key', baseUrl: 'https://example.com' })).toEqual({
      apiKey: 'aff-key',
      baseUrl: 'https://example.com',
    });
  });

  it('parses a pasted Attio access token, with or without a base URL', () => {
    // Attio access tokens authenticate like the OAuth ones, so the pasted
    // value lands in the SAME `accessToken` envelope the callback stores.
    const spec = connectFormSpecForType(ExternalServiceType.ATTIO)!;
    expect(spec.parse({ accessToken: ' attio-tok ' })).toEqual({ accessToken: 'attio-tok' });
    expect(spec.parse({ accessToken: 'attio-tok', baseUrl: 'https://api.example.com' })).toEqual({
      accessToken: 'attio-tok',
      baseUrl: 'https://api.example.com',
    });
  });

  it('rejects a blank Attio access token', () => {
    const spec = connectFormSpecForType(ExternalServiceType.ATTIO)!;
    expect(() => spec.parse({ accessToken: '   ' })).toThrow();
  });

  it('every key-entry spec carries a where-to-find-this guide', () => {
    // The landing page renders these steps above the form — a bare "API key"
    // input with no pointer to the provider's UI is exactly what we're avoiding.
    for (const type of [
      ExternalServiceType.AFFINITY,
      ExternalServiceType.ATTIO,
      ExternalServiceType.GRANOLA,
      ExternalServiceType.EVERTRACE,
    ]) {
      const spec = connectFormSpecForType(type)!;
      expect(spec.guide?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('renders the Evertrace form as a secret key plus an optional base URL', () => {
    const spec = connectFormSpecForType(ExternalServiceType.EVERTRACE)!;
    expect(spec.fields.map((f) => f.name)).toEqual(['apiKey', 'baseUrl']);
    expect(spec.parse({ apiKey: ' sk_live_x ', baseUrl: '' })).toEqual({ apiKey: 'sk_live_x' });
    expect(() => spec.parse({ apiKey: '  ' })).toThrow();
  });

  it('has no spec for intrinsic / handshake credentials', () => {
    expect(isKeyEntryConnectable(ExternalServiceType.NATIVE_VALUATIONS)).toBe(false);
    expect(isKeyEntryConnectable(ExternalServiceType.TELEGRAM)).toBe(false);
  });
});

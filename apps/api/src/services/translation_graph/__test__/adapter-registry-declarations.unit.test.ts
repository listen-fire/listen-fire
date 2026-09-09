/**
 * Locks down the registry-level adapter declarations that power the dynamic
 * Read-from / Write-to pickers (the credential-type map + the writable set,
 * relocated from the editor client). Pure functions — no DB, no adapter
 * construction.
 *
 */

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import {
  adapterRequiredCredentialType,
  getBrandIcon,
  isWritableAdapterType,
  listAdapterCapabilities,
  resolveAdapterSlug,
} from '../adapters/registry';

describe('adapterRequiredCredentialType', () => {
  it('maps external adapters to their credential service type', () => {
    expect(adapterRequiredCredentialType('attio')).toBe(ExternalServiceType.ATTIO);
    expect(adapterRequiredCredentialType('slack')).toBe(ExternalServiceType.SLACK);
    expect(adapterRequiredCredentialType('affinity')).toBe(ExternalServiceType.AFFINITY);
    expect(adapterRequiredCredentialType('airtable')).toBe(ExternalServiceType.AIRTABLE);
    expect(adapterRequiredCredentialType('dropbox')).toBe(ExternalServiceType.DROPBOX);
  });

  it('maps both Google adapters to the single GOOGLE credential type', () => {
    expect(adapterRequiredCredentialType('google_sheets')).toBe(ExternalServiceType.GOOGLE);
    expect(adapterRequiredCredentialType('google_drive')).toBe(ExternalServiceType.GOOGLE);
  });

  it('maps kg to its credential type (knowledge is credential-backed — D25/D41)', () => {
    expect(adapterRequiredCredentialType('kg')).toBe(ExternalServiceType.NATIVE_KNOWLEDGE);
  });

  it('returns null for credential-free adapters (email / whatsapp — inbound creds live on the legacy pipeline_input)', () => {
    expect(adapterRequiredCredentialType('email')).toBeNull();
    expect(adapterRequiredCredentialType('whatsapp')).toBeNull();
  });

  it('accepts trigger-kind aliases, not just canonical slugs', () => {
    // Uppercase trigger kinds resolve through KIND_TO_ADAPTER_SLUG first.
    expect(adapterRequiredCredentialType('ATTIO')).toBe(ExternalServiceType.ATTIO);
    expect(adapterRequiredCredentialType('GOOGLE_SHEETS')).toBe(ExternalServiceType.GOOGLE);
    // Email-style kinds alias the credential-free email adapter.
    expect(adapterRequiredCredentialType('CUSTOM_EMAIL')).toBeNull();
    expect(adapterRequiredCredentialType('MAILGUN')).toBeNull();
  });
});

describe('getBrandIcon', () => {
  it('reads the icon manifest-first off each adapter that declares one', () => {
    expect(getBrandIcon('attio')?.viewBox).toBe('2 3 30 28');
    expect(getBrandIcon('slack')).toEqual({
      d: expect.stringContaining('M5.042 15.165'),
      fill: true,
    });
    expect(getBrandIcon('telegram')?.fill).toBe(true);
  });

  it('accepts trigger-kind aliases, not just canonical slugs', () => {
    expect(getBrandIcon('ATTIO')).toEqual(getBrandIcon('attio'));
    expect(getBrandIcon('CUSTOM_EMAIL')).toEqual(getBrandIcon('email'));
  });

  it('returns null for adapters with no declared brand mark (KG, valuations)', () => {
    expect(getBrandIcon('kg')).toBeNull();
    expect(getBrandIcon('native-valuations')).toBeNull();
  });

  it('a built-in with no brand may still declare a MARK — manual owns a stroked glyph', () => {
    // Nothing to brand, but a source card that shows no mark reads as a source
    // we failed to identify (renderer redline 10), so manual draws a glyph.
    expect(getBrandIcon('manual')).toEqual({ d: expect.any(String), fill: false });
  });

  it('returns null for an unknown adapter type', () => {
    expect(getBrandIcon('not-a-real-adapter')).toBeNull();
  });
});

describe('isWritableAdapterType', () => {
  it('marks adapters with a real createRecord as writable targets', () => {
    expect(isWritableAdapterType('kg')).toBe(true);
    expect(isWritableAdapterType('attio')).toBe(true);
    expect(isWritableAdapterType('affinity')).toBe(true);
    expect(isWritableAdapterType('airtable')).toBe(true);
    expect(isWritableAdapterType('google_sheets')).toBe(true);
    expect(isWritableAdapterType('google_drive')).toBe(true);
    expect(isWritableAdapterType('dropbox')).toBe(true);
    expect(isWritableAdapterType('native-valuations')).toBe(true);
    // Slack's createRecord is a real post-message / thread-reply write.
    expect(isWritableAdapterType('slack')).toBe(true);
    // WhatsApp's createRecord is a real send — replies / reactions / typing
    // created along a message's edges (the unified write surface).
    expect(isWritableAdapterType('whatsapp')).toBe(true);
  });

  it('excludes source-only adapters', () => {
    // email inherits BaseAdapter's notWriteCapable throw (no createRecord).
    expect(isWritableAdapterType('email')).toBe(false);
  });

  it('accepts trigger-kind aliases', () => {
    expect(isWritableAdapterType('ATTIO')).toBe(true);
    expect(isWritableAdapterType('SLACK')).toBe(true);
  });
});

describe('listAdapterCapabilities', () => {
  const bySlug = () => {
    const map = new Map(listAdapterCapabilities().map((c) => [c.adapterType, c]));
    return (slug: string) => {
      const c = map.get(slug);
      if (!c) throw new Error(`no capability summary for ${slug}`);
      return c;
    };
  };

  it('classifies sources from declared triggers and targets from writability', () => {
    const get = bySlug();
    // Manual (the unified on-demand source, formerly also `web`) + email are
    // sources (declare triggers), not targets.
    expect(get('manual').canSource).toBe(true);
    expect(get('manual').canTarget).toBe(false);
    expect(get('email').canSource).toBe(true);
    expect(get('email').canTarget).toBe(false);
    // Sheets is a write-only target, not a source.
    expect(get('google_sheets').canTarget).toBe(true);
    expect(get('google_sheets').canSource).toBe(false);
  });

  it('reports required-credential type so callers can flag connect-first', () => {
    const get = bySlug();
    // Manual needs no credential; Attio needs its external service.
    expect(get('manual').requiredCredentialType).toBeNull();
    expect(get('attio').requiredCredentialType).toBe(ExternalServiceType.ATTIO);
  });

  it('surfaces every registered adapter (nothing whitelisted out)', () => {
    const slugs = listAdapterCapabilities().map((c) => c.adapterType);
    for (const slug of ['manual', 'email', 'attio', 'google_sheets', 'slack']) {
      expect(slugs).toContain(slug);
    }
    // `web` folded into `manual` — it is no longer its own adapter, but the
    // legacy slug still resolves so stored web-trigger rows route to manual.
    expect(slugs).not.toContain('web');
    expect(resolveAdapterSlug('web')).toBe('manual');
    expect(resolveAdapterSlug('WEB')).toBe('manual');
    // Pipedrive was removed entirely (2026-07-04) — it was an unconnectable
    // stub (no credential path existed) that only ever dead-ended users.
    expect(slugs).not.toContain('pipedrive');
  });
});

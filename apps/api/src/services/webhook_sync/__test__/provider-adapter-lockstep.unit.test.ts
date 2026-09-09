// Lockstep guard: every registered webhook provider key MUST resolve to a
// registered movement adapter through the registry's trigger-kind alias map.
//
// Why this exists: the handler used to map provider keys with a naming
// convention (lowercase + hyphens), which silently broke the INBOUND_WHATSAPP
// door — 'inbound-whatsapp' is not a registered slug, so `hasAdapter` returned
// false and dispatch was skipped forever, with nothing failing anywhere. A
// webhook door that accepts deliveries and drops them is worse than no door:
// operators follow the provider's setupInstructions, wire the webhook, and
// get silence. This test makes that class of breakage impossible to
// reintroduce: register a provider whose key the adapter registry can't
// resolve and the suite fails.
//
// Both dispatch call sites in handler.ts resolve via `resolveAdapterSlug`
// (the same map `getAdapter` itself uses), so this guard covering the
// registry covers the handler.

import { listWebhookProviders } from '../providers';
import {
  hasAdapter,
  resolveAdapterSlug,
} from '../../translation_graph/adapters/registry';

describe('webhook provider ↔ adapter registry lockstep', () => {
  const providerKeys = listWebhookProviders().map((p) => p.provider);

  it('has at least the known provider set registered', () => {
    // Sanity floor so an accidentally emptied registry can't vacuously pass.
    expect(providerKeys).toEqual(
      expect.arrayContaining(['ATTIO', 'AIRTABLE', 'SLACK', 'TELEGRAM', 'INBOUND_WHATSAPP']),
    );
  });

  it.each(listWebhookProviders().map((p) => [p.provider] as const))(
    'provider key %s resolves to a registered adapter',
    (key) => {
      const slug = resolveAdapterSlug(key);
      expect(hasAdapter(slug)).toBe(true);
    },
  );

  it('the INBOUND_WHATSAPP door resolves to the whatsapp adapter (the regression)', () => {
    expect(resolveAdapterSlug('INBOUND_WHATSAPP')).toBe('whatsapp');
    expect(hasAdapter(resolveAdapterSlug('INBOUND_WHATSAPP'))).toBe(true);
  });
});

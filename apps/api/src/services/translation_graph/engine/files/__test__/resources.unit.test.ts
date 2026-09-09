// Unit tests for the engine-side resource resolution helper —
// `resolvePositionResources` walks an adapter's `_resources` reference and
// reads the `Resource` off each result, applying the author `ResourceFilter`.
//
// NOTE (Layer 5): `_resources` is extracted-node provenance now, NOT an
// input-side bundle. Input/source adapters (email/whatsapp/slack/…) no longer
// declare a `_resources` reference, so walking one off an input position
// drifts — the function is unchanged, the adapters stopped exposing the edge.
// The filter/stamp behaviour is still covered directly below via
// `matchesResourceFilter` / `stampResourceId`.

import { EmailAdapter, EMAIL_ADAPTER_TYPE, EMAIL_RECORD_TYPE_ID } from '../../../adapters/email';
import type { EmailPayload } from '../../../adapters/email';
import { makeStablePosition } from '../../../types';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { matchesResourceFilter, resolvePositionResources, stampResourceId } from '../resources';
import type { Resource } from '../../../adapter';
import type { ResourceId } from '../../../../../generated/kysely/knowledge/Resource';

const TEAM_ID = 'team-1' as TeamId;

const PAYLOAD: EmailPayload = {
  messageId: 'm-1@example.com',
  subject: 'Deck attached',
  sender: 'a@x',
  recipient: 'b@x',
  bodyText: 'See attached.',
  attachments: [
    { key: 'handle-1', filename: 'deck.pdf', contentType: 'application/pdf', size: 10 },
    { key: 'handle-2', filename: 'logo.png', contentType: 'image/png' },
  ],
};

function position() {
  return makeStablePosition({
    adapterType: EMAIL_ADAPTER_TYPE,
    recordType: EMAIL_RECORD_TYPE_ID,
    recordId: 'rec-1',
    data: PAYLOAD,
  });
}

describe('resolvePositionResources over an input adapter', () => {
  it('no longer resolves `_resources` off an input email position (the adapter dropped the reference)', async () => {
    // Input content is read explicitly now (the `Body` field + the
    // `attachments` edge). `_resources` is reachable only off an extracted
    // node, so walking it off an input position drifts.
    const adapter = new EmailAdapter(TEAM_ID);
    await expect(
      resolvePositionResources({ adapter, position: position() }),
    ).rejects.toThrow();
  });
});

describe('stampResourceId', () => {
  it('mints a UUID when the resource has no id', () => {
    const r: Resource = { externalId: 'ext-1', type: 'TEXT' };
    const stamped = stampResourceId(r);
    expect(stamped.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stamped.externalId).toBe('ext-1');
  });

  it('passes through a resource that already carries an id', () => {
    const r: Resource = { id: 'existing-uuid' as ResourceId, type: 'TEXT' };
    expect(stampResourceId(r)).toBe(r);
  });
});

describe('matchesResourceFilter', () => {
  const file = { type: 'FILE' as const, name: 'deck.pdf', contentType: 'application/pdf', url: 'u' };

  it('passes when no filter is supplied', () => {
    expect(matchesResourceFilter(file, undefined)).toBe(true);
  });

  it('narrows by resourceType / mimeType / namePattern / hasDocument', () => {
    expect(matchesResourceFilter(file, { resourceType: 'TEXT' })).toBe(false);
    expect(matchesResourceFilter(file, { mimeType: 'application/pdf' })).toBe(true);
    expect(matchesResourceFilter(file, { namePattern: '\\.pdf$' })).toBe(true);
    expect(matchesResourceFilter(file, { namePattern: '\\.png$' })).toBe(false);
    expect(matchesResourceFilter({ ...file, url: null }, { hasDocument: true })).toBe(false);
  });
});

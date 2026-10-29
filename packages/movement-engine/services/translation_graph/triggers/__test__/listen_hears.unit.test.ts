// The connection routing rule against the table of cases listen-fire's Rust is held
// to as well (packages/engine-contracts/conformance/listen-hears.json).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listenHearsCredential, listenerHearsDelivery } from '../listen_config';

interface HearsCase {
  case: string;
  listen: string | null;
  delivery: string | null;
  hears: boolean;
}

// Test data, not a published export: read where the repository keeps it.
const cases: { cases: HearsCase[] } = JSON.parse(readFileSync(join(__dirname, '../../../../../engine-contracts/conformance/listen-hears.json'), 'utf8'));

const event = { payload: {}, eventType: 'note.created' };

describe('which listens a delivery reaches, by credential', () => {
  it.each(cases.cases)('$case', ({ listen, delivery, hears }) => {
    const listened = listen ?? undefined;
    const delivered = delivery ?? undefined;
    expect(listenHearsCredential(listened, delivered)).toBe(hears);
    const listener = { adapter: 'notes', config: { events: ['note.created'] }, ...(listened !== undefined ? { credentialName: listened } : {}) };
    expect(listenerHearsDelivery(listener, { adapterType: 'notes', ...(delivered !== undefined ? { credentialName: delivered } : {}), event })).toBe(hears);
  });
});

// The describing query through its binding, over the native service's own
// catalog fixture (crates/movement-language/tests/fixtures/service/): every
// connection at its root, one place an address names, and an address the
// checker refuses.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CatalogSnapshot } from '../snapshot';
import { describeAddress, describeCatalog } from '../description';

const FIXTURES = path.join(__dirname, '../../../../crates/movement-language/tests/fixtures/service');
const SNAPSHOT: CatalogSnapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'catalog.json'), 'utf8'));

describe('the describing query', () => {
  it('describes every connection at its root, each edge with where it lands', () => {
    const described = describeCatalog(SNAPSHOT, { landings: { fields: 1 } });
    expect(described.legend).toBe('plain edges read; [r w fires] read, write, listen; ! required, * identifying, ~ read only');
    expect(described.connections.map((c) => `${c.adapter}:${c.key}`)).toEqual(['cron:', 'manual:', 'slack:']);
    const manual = described.connections[1].place.edges[0];
    expect(manual).toMatchObject({ step: '-[:Invocations]->', hop: '-[:Invocations]-> Invocation [fires]', read: false, write: false, fires: true });
    expect(manual.lands?.fields).toEqual({ shown: [expect.objectContaining({ name: 'Text', written: 'Text text', markedName: 'Text' })], cut: 1 });
  });

  it('describes the place an address names, with its edges one level deep', () => {
    const described = describeAddress(SNAPSHOT, '@lf/slack-[:Channels]->');
    expect(described.diagnostics).toEqual([]);
    expect(described.place).toMatchObject({ name: 'channel', description: 'A place the team talks.', known: 'whole' });
    expect(described.place?.fields.shown[0]).toMatchObject({ written: 'Name text', description: "The channel's name, without its #." });
    const messages = described.place?.edges[0];
    expect(messages).toMatchObject({ hop: '-[:Messages]-> message', description: 'What was said in the channel, oldest first.' });
    expect(messages?.lands?.fields.shown.map((f) => f.written)).toEqual(['Body text', 'Score number']);
    expect(messages?.lands?.edges).toEqual([]);
  });

  it('answers an address the checker refuses with its diagnostic, and a connection with its record types', () => {
    const refused = describeAddress(SNAPSHOT, '@lf/slack-[:Chanels]->');
    expect(refused.place).toBeNull();
    expect(refused.diagnostics).toEqual([expect.objectContaining({ code: 'MOV_TRAVERSE_UNKNOWN_EDGE', severity: 'error' })]);
    const connection = describeAddress(SNAPSHOT, '@lf/slack');
    expect(connection.records?.map((r) => r.name)).toEqual(['channel', 'message']);
  });
});

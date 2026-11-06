// `normalisedActor` held to the table in docs/contracts/actor-field.md, as
// language-versions.md's table is held in both implementations.
import fs from 'fs';
import path from 'path';

import { ACTOR_FIELDS, normalisedActor } from '../index';
import type { ActorIdentity } from '../index';

const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/contracts/actor-field.md'), 'utf8');

const rows = [...doc.matchAll(/^\| `(\{"identifier".*?\})` \| `(\{.*?\})` \|$/gm)].map((match) => ({
  identity: JSON.parse(match[1]) as ActorIdentity,
  fields: JSON.parse(match[2]) as Record<string, unknown>,
}));

describe('normalisedActor', () => {
  it('reads the document table, at least its documented rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  it.each(rows.map((row) => [JSON.stringify(row.identity), row] as const))('%s', (_, row) => {
    expect(normalisedActor(row.identity)).toEqual(row.fields);
  });

  it('offers no Actor for an identity with no identifier', () => {
    expect(normalisedActor({ identifier: '', scheme: 'opaque' })).toBeNull();
    expect(normalisedActor({ identifier: '  ', scheme: 'email', email: 'a@x.com' })).toBeNull();
    expect(normalisedActor({ identifier: '\u0085', scheme: 'opaque' })).toBeNull();
    expect(normalisedActor({ identifier: '\ufeff', scheme: 'opaque' })).toBeNull();
  });

  it('only ever yields the listed fields', () => {
    for (const row of rows) for (const key of Object.keys(normalisedActor(row.identity) ?? {})) expect(ACTOR_FIELDS).toContain(key);
  });
});

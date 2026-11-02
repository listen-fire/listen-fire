// A record's `Changes` (changes.ts): Affinity's webhook events as arrivals on
// the Changes of the organization, person, opportunity or list entry each is
// about, each record type's changes their own change type, carrying the record
// as Affinity holds it now. The connection's one webhook, the wait keys, the
// walk from a change to its record, and the listen the checker takes.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { LANGUAGE_VERSION, checkSourceInRust, type CatalogSnapshot } from 'movement-lang';
import { instanceSchemaFromDescriptors, makeStablePosition, positionData } from 'movement-engine/public/catalog';

import { AFFINITY_RECORD_EVENTS } from '../changes';
import affinityModule from '../index';
import { makeAdapter } from '../testing';

const LIST_SCORE = { id: 77, field_id: 103, list_entry_id: 13, value: 5 };

const fieldValue = (type: string, body: Record<string, unknown>) => ({ type, body, sent_at: 1_790_000_000 });

describe('@lf/affinity declares a record’s Changes', () => {
  it('lists Changes on organizations, people, opportunities and each list’s entries, each landing on its own change type', async () => {
    const { adapter } = makeAdapter();
    const changesOf = async (type: string) => (await adapter.describe(type))?.references.find((r) => r.name === 'Changes');
    expect(await changesOf('Organization')).toMatchObject({
      targetTypeId: 'OrganizationChange',
      listenable: true,
      readable: false,
      delivery: 'connection',
      identity: 'Id',
      attributes: true,
      carries: ['Organization'],
    });
    expect((await changesOf('Person'))?.targetTypeId).toBe('PersonChange');
    expect((await changesOf('Opportunity'))?.targetTypeId).toBe('OpportunityChange');
    expect(await changesOf('List Entry — Hot Leads')).toMatchObject({ targetTypeId: 'List Entry Change — Hot Leads', carries: ['List Entry — Hot Leads'] });
    expect((await changesOf('List Entry — People List'))?.targetTypeId).toBe('List Entry Change — People List');
    // The generic entry names no list to be typed by; a note announces nothing.
    expect(await changesOf('List Entry')).toBeUndefined();
    expect(await changesOf('Note')).toBeUndefined();

    const entries = await adapter.listEntryPoints();
    expect(entries.find((e) => e.typeId === 'List Entry Change — Hot Leads')).toEqual({
      typeId: 'List Entry Change — Hot Leads',
      displayName: 'List Entry Change — Hot Leads',
      readable: false,
      writable: false,
    });
  });

  it("names a change's Field from the record's own custom fields, and walks to the record", async () => {
    const { adapter } = makeAdapter();
    const entryChange = await adapter.describe('List Entry Change — Hot Leads');
    const fields = new Map(entryChange?.fields.map((f) => [f.displayName, f]));
    expect(fields.get('Kind')?.enumValues).toEqual(['created', 'updated', 'deleted']);
    // The list's own fields, its prefix off (a name another field already has keeps it), record-valued ones too.
    expect(fields.get('Field')?.enumValues).toEqual(expect.arrayContaining(['List Score', 'Affinity Score', '[Hot Leads] Segment', 'Tags', 'Owners']));
    expect(fields.get('Field')?.enumValues).not.toContain('listName');
    expect(entryChange?.references).toEqual([expect.objectContaining({ name: 'List Entry', targetTypeId: 'List Entry — Hot Leads', requiresLiveRecord: true })]);

    const orgChange = await adapter.describe('OrganizationChange');
    const orgField = orgChange?.fields.find((f) => f.displayName === 'Field');
    // An organization.updated names no field, so only custom fields are ever named.
    expect(orgField?.enumValues).toEqual(expect.arrayContaining(['Stage', 'Employees', 'Primary Contact']));
    expect(orgField?.enumValues).not.toContain('Name');
    expect(orgChange?.references[0]).toMatchObject({ name: 'Organization', targetTypeId: 'Organization' });
  });
});

describe('@lf/affinity reports each event as the arrival on its record’s Changes', () => {
  it('a list entry’s field value arrives on that entry’s Changes, naming the field and carrying the entry as it is now', async () => {
    const { adapter } = makeAdapter({ fieldValues: [LIST_SCORE] });
    const { events, arrivals } = await adapter.preprocessInbound({
      raw: fieldValue('field_value.updated', { ...LIST_SCORE, entity_type: 1, entity_id: 42, updated_at: '2026-10-01T09:00:00Z' }),
    });
    expect(events).toEqual([]);
    expect(arrivals).toHaveLength(1);
    const [arrival] = arrivals;
    expect(arrival).toMatchObject({
      edge: 'Changes',
      key: 'list-entry:13',
      landing: { recordType: 'List Entry Change — Hot Leads', fields: { Kind: 'updated', Record: '13', Field: 'List Score' } },
      parents: [{ recordId: '13', recordType: 'List Entry — Hot Leads', fields: { 'List Score': 5, listName: 'Hot Leads' } }],
      about: { recordType: 'List Entry — Hot Leads', externalId: '13' },
      occurredAt: '2026-10-01T09:00:00Z',
    });
    expect(arrival?.identity).toBe(arrival?.landing.fields['Id']);
    expect(arrival?.landing.recordId).toBe(arrival?.identity);
  });

  it('the same delivery again names the same change, and the field’s next value another', async () => {
    const { adapter } = makeAdapter({ fieldValues: [LIST_SCORE] });
    const identity = async (value: number) =>
      (await adapter.preprocessInbound({ raw: fieldValue('field_value.updated', { ...LIST_SCORE, value, entity_type: 1, entity_id: 42 }) })).arrivals[0]?.identity;
    expect(await identity(5)).toBe(await identity(5));
    expect(await identity(6)).not.toBe(await identity(5));
  });

  it('an organization’s own events arrive on its Changes; a deleted one carries nothing', async () => {
    const { adapter } = makeAdapter();
    const created = (await adapter.preprocessInbound({ raw: fieldValue('organization.created', { id: 7101, name: 'Acme', domain: 'acme.com' }) })).arrivals[0];
    expect(created).toMatchObject({
      key: 'organization:7101',
      landing: { recordType: 'OrganizationChange', fields: { Kind: 'created', Record: '7101' } },
      parents: [{ recordType: 'Organization', fields: { Name: 'Acme', Domain: 'acme.com' } }],
      about: { recordType: 'Organization', externalId: '7101' },
      // No time in the body: when Affinity sent it.
      occurredAt: new Date(1_790_000_000 * 1000).toISOString(),
    });
    expect(created?.landing.fields).not.toHaveProperty('Field');
    const deleted = (await adapter.preprocessInbound({ raw: fieldValue('organization.deleted', { id: 7101, name: 'Acme' }) })).arrivals[0];
    expect(deleted).toMatchObject({ landing: { fields: { Kind: 'deleted' } }, parents: [null] });
  });

  it('a field value on an organization is its update, naming the field; one on an opportunity carries the opportunity', async () => {
    const { adapter } = makeAdapter();
    const stage = (await adapter.preprocessInbound({ raw: fieldValue('field_value.created', { id: 90, field_id: 100, entity_type: 1, entity_id: 7101, list_entry_id: null, value: 2 }) })).arrivals[0];
    expect(stage).toMatchObject({ key: 'organization:7101', landing: { recordType: 'OrganizationChange', fields: { Kind: 'updated', Field: 'Stage' } } });
    const opportunity = (await adapter.preprocessInbound({ raw: fieldValue('opportunity.updated', { id: 700, name: 'Acme — Series A' }) })).arrivals[0];
    expect(opportunity).toMatchObject({ landing: { recordType: 'OpportunityChange' }, parents: [{ recordType: 'Opportunity', fields: { Name: 'Acme — Series A' } }] });
  });

  it('a list_entry event types the entry by the list its body names', async () => {
    const { adapter } = makeAdapter();
    const added = (await adapter.preprocessInbound({ raw: fieldValue('list_entry.created', { id: 13, list_id: 556, entity_id: 7201, entity_type: 0, created_at: '2026-10-02T00:00:00Z' }) })).arrivals[0];
    expect(added).toMatchObject({ key: 'list-entry:13', landing: { recordType: 'List Entry Change — People List', fields: { Kind: 'created' } }, occurredAt: '2026-10-02T00:00:00Z' });
  });

  it('a note, a reminder, a list and junk run nothing', async () => {
    const { adapter } = makeAdapter();
    for (const raw of [
      fieldValue('note.created', { id: 500, content: 'hi' }),
      fieldValue('reminder.updated', { id: 800 }),
      fieldValue('list.created', { id: 9 }),
      { nonsense: true },
    ]) {
      expect(await adapter.preprocessInbound({ raw })).toEqual({ events: [], arrivals: [] });
    }
  });

  it('a field value’s change says how it changed and holds its value, typed by the field: new on a set or a change, removed on a clear', async () => {
    const { adapter } = makeAdapter();
    const landing = async (type: string, body: Record<string, unknown>) => {
      const [arrival] = (await adapter.preprocessInbound({ raw: fieldValue(type, { entity_type: 1, entity_id: 7101, list_entry_id: null, ...body }) })).arrivals;
      return arrival !== undefined && 'landing' in arrival ? arrival.landing : undefined;
    };
    // A ranked dropdown arrives as its option, a plain one as the option's id: each reads as its label.
    expect(await landing('field_value.created', { id: 90, field_id: 100, value: { id: 2, text: 'Series A', rank: 1, color: 0 } })).toEqual({
      recordId: expect.any(String),
      recordType: 'OrganizationChange',
      fields: expect.objectContaining({ Kind: 'updated', Field: 'Stage', 'Field Change': 'set', Current: { Stage: 'Series A' } }),
    });
    // Affinity does not send the value a change replaced: a filter on Previous is undecided.
    expect(await landing('field_value.updated', { id: 91, field_id: 105, value: 8 })).toMatchObject({
      fields: { Field: 'Segment', 'Field Change': 'changed', Current: { Segment: 'Enterprise' } },
      unknown: ['Previous'],
    });
    const cleared = await landing('field_value.deleted', { id: 92, field_id: 101, value: 40 });
    expect(cleared).toMatchObject({ fields: { Field: 'Employees', 'Field Change': 'cleared', Previous: { Employees: 40 } } });
    expect(cleared?.fields).not.toHaveProperty('Current');
    expect(cleared).not.toHaveProperty('unknown');
    // A field holding several values holds the one added, as a list.
    const [tag] = (await adapter.preprocessInbound({ raw: fieldValue('field_value.created', { id: 93, field_id: 110, entity_type: 1, entity_id: 7101, list_entry_id: 13, value: 'fintech' }) })).arrivals;
    expect(tag).toMatchObject({ landing: { recordType: 'List Entry Change — Hot Leads', fields: { Field: 'Tags', Current: { Tags: ['fintech'] } } } });
    // An organization's own update is no field's change.
    const own = await landing('organization.updated', { id: 7101, name: 'Acme' });
    expect(own?.fields).not.toHaveProperty('Field Change');
    expect(own?.fields).not.toHaveProperty('Current');
  });

  it('a field value whose field the record type does not name has its Field, and what it held, unknown', async () => {
    const { adapter } = makeAdapter();
    const [arrival] = (await adapter.preprocessInbound({ raw: fieldValue('field_value.updated', { id: 94, field_id: 999, entity_type: 1, entity_id: 7101, list_entry_id: null, value: 'x' }) })).arrivals;
    expect(arrival).toMatchObject({
      key: 'organization:7101',
      landing: { recordType: 'OrganizationChange', fields: { Kind: 'updated', 'Field Change': 'changed' }, unknown: ['Field', 'Current', 'Previous'] },
    });
    expect(arrival !== undefined && 'landing' in arrival ? arrival.landing.fields : {}).not.toHaveProperty('Field');
  });

  it("an opportunity list's columns are its entries' fields, read-only, and a change names one", async () => {
    const { adapter } = makeAdapter({ fieldValues: [{ id: 95, field_id: 300, list_entry_id: 9302, value: { id: 30, text: 'Sourced', rank: 0, color: 0 } }] });
    const entry = await adapter.describe('List Entry — Deals');
    expect(entry?.fields.find((f) => f.displayName === 'Deal Stage')).toMatchObject({ kind: 'enum', enumValues: ['Sourced'], writable: false });
    expect((await adapter.describe('List Entry Change — Deals'))?.fields.find((f) => f.displayName === 'Field')?.enumValues).toEqual(['Deal Stage']);
    const [moved] = (await adapter.preprocessInbound({ raw: fieldValue('field_value.updated', { id: 95, field_id: 300, entity_type: 8, entity_id: 700, list_entry_id: 9302, value: 30 }) })).arrivals;
    expect(moved).toMatchObject({
      landing: { recordType: 'List Entry Change — Deals', fields: { Field: 'Deal Stage', Current: { 'Deal Stage': 'Sourced' } } },
      parents: [{ recordType: 'List Entry — Deals', fields: { 'Deal Stage': 'Sourced', listName: 'Deals' } }],
    });
    const position = makeStablePosition({ adapterType: 'affinity', recordType: 'List Entry — Deals', recordId: '9302', data: {} });
    expect(await adapter.getFieldValue({ position, fieldId: 'Deal Stage' })).toBe('Sourced');
  });

  it("an opportunity list's column names its list from the workspace's whole field catalog", async () => {
    const { adapter } = makeAdapter();
    const moved = (await adapter.preprocessInbound({ raw: fieldValue('field_value.updated', { id: 91, field_id: 300, entity_type: 8, entity_id: 700, list_entry_id: 9302, value: 30 }) })).arrivals[0];
    expect(moved).toMatchObject({ key: 'list-entry:9302', landing: { recordType: 'List Entry Change — Deals', fields: { Kind: 'updated', Record: '9302' } } });
  });

  it('a list entry change whose list the workspace does not name states no record type, so each listen on Changes says it could not judge it', async () => {
    const { adapter } = makeAdapter();
    const unplaced = async (raw: unknown) => (await adapter.preprocessInbound({ raw })).arrivals;
    const byField = await unplaced(fieldValue('field_value.updated', { id: 1, field_id: 999, entity_type: 1, entity_id: 7101, list_entry_id: 13, value: 'x' }));
    expect(byField).toEqual([
      {
        edge: 'Changes',
        key: 'list-entry:13',
        identity: expect.stringMatching(/^field_value\.updated:1:/),
        // Its field is named by a record type it has none of: a filter on `Field` is undecided, not false.
        landing: {
          recordId: byField[0]?.identity,
          fields: { Id: byField[0]?.identity, Kind: 'updated', Record: '13', 'Field Change': 'changed' },
          unknown: ['Field', 'Current', 'Previous'],
        },
        parents: [null],
        occurredAt: '2026-09-21T14:13:20.000Z',
      },
    ]);
    const byList = await unplaced(fieldValue('list_entry.created', { id: 14, list_id: 9999, entity_id: 7201, entity_type: 0 }));
    expect(byList).toMatchObject([{ key: 'list-entry:14', landing: { fields: { Kind: 'created', Record: '14' } }, parents: [null] }]);
    expect(byList[0] !== undefined && 'landing' in byList[0] ? byList[0].landing.recordType : 'gone').toBeUndefined();
  });
});

describe('@lf/affinity waits, walks and subscribes on Changes', () => {
  it('keys a wait on a record’s Changes by its kind and id, as its arrivals are keyed, and knows no other edge', async () => {
    const { adapter } = makeAdapter();
    const heads = [
      { recordId: '13', recordType: 'Organization' },
      { recordId: '13', recordType: 'Person' },
      { recordId: '13', recordType: 'List Entry — Hot Leads' },
      { recordId: '13', recordType: 'Opportunity' },
    ];
    expect(await adapter.arrivals.awaitKeys({ edge: 'Changes', heads })).toEqual([
      { key: 'organization:13' },
      { key: 'person:13' },
      { key: 'list-entry:13' },
      { key: 'opportunity:13' },
    ]);
    // The key a wait on organization 7101 opens under is the key its change arrives on.
    const change = (await adapter.preprocessInbound({ raw: fieldValue('organization.updated', { id: 7101, name: 'Acme' }) })).arrivals[0];
    expect(await adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: '7101', recordType: 'Organization' }] })).toEqual([{ key: change?.key }]);
    await expect(adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: '7101' }] })).rejects.toThrow(/needs its record type/);
    await expect(adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: '5', recordType: 'Note' }] })).rejects.toThrow(/a Note has no Changes/);
    await expect(adapter.arrivals.awaitKeys({ edge: 'Notes', heads: [{ recordId: '7101' }] })).rejects.toThrow(/'Notes' is not a listenable edge/);
  });

  it('reads a change’s fields off its landing and walks to the record it changed', async () => {
    const { adapter } = makeAdapter();
    const change = makeStablePosition({ adapterType: 'affinity', recordType: 'OrganizationChange', recordId: 'c1', data: { Id: 'c1', Kind: 'updated', Record: '7101', Field: 'Stage' } });
    expect(await adapter.getFieldValue({ position: change, fieldId: 'Field' })).toBe('Stage');
    const [org] = await adapter.getRelated({ position: change, fieldId: 'Organization', direction: 'outgoing' });
    expect(org?.position.recordType).toBe('Organization');
    expect(positionData(org!.position)).toMatchObject({ name: 'Acme' });
    expect(await adapter.getRelated({ position: change, fieldId: 'Person', direction: 'outgoing' })).toEqual([]);
  });

  it('makes one webhook taking every record event for the edge, keeps a held one, and deletes it', async () => {
    const { adapter, calls } = makeAdapter();
    const made = await adapter.ensureEventSubscription({ edge: 'Changes', callbackUrl: 'https://lf.example/hooks/affinity' });
    expect(made).toEqual({ externalId: '31' });
    expect(calls.webhooks).toEqual([{ made: { webhookUrl: 'https://lf.example/hooks/affinity', subscriptions: [...AFFINITY_RECORD_EVENTS] } }]);
    expect(AFFINITY_RECORD_EVENTS).toEqual(expect.arrayContaining(['organization.created', 'list_entry.deleted', 'field_value.updated']));
    expect(await adapter.ensureEventSubscription({ edge: 'Changes', callbackUrl: 'https://lf.example/hooks/affinity', current: { externalId: '31' } })).toBeUndefined();
    await expect(adapter.ensureEventSubscription({ edge: 'Notes', callbackUrl: 'https://lf.example/hooks/affinity' })).rejects.toThrow(/not a listenable edge/);
    await adapter.removeEventSubscription({ edge: 'Changes', callbackUrl: 'https://lf.example/hooks/affinity', externalId: '31' });
    expect(calls.webhooks.at(-1)).toEqual({ deleted: '31' });
  });

  it('states adapter protocol 2.6, answers awaitKeys, and keeps no 0.12 settings vocabulary', () => {
    expect(affinityModule.protocolMinor).toBe(6);
    expect(affinityModule.manifest.methods).toContain('awaitKeys');
    expect(affinityModule.manifest).not.toHaveProperty('subscribableEvents');
    expect(affinityModule.manifest.supportedTriggers).toEqual(['webhook']);
  });
});

describe('a listen on a list’s entries’ Changes reaches the checker', () => {
  async function snapshot(): Promise<CatalogSnapshot> {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (await Promise.all(entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const))).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const { schema } = instanceSchemaFromDescriptors({ adapterType: 'affinity', entries, descriptors, supportsInPlaceUpdate: true });
    return {
      adapters: { affinity: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], canFire: true, schemas: { affinity_creds: schema } } },
      credentials: { affinity_creds: { adapters: ['affinity'] } },
      plugins: {},
    };
  }

  const program = (field: string) => `import { affinity } from adapters
import { affinity_creds } from credentials

crm = connect affinity using affinity_creds

function scored(c: <crm-[:\`List Entry Change — Hot Leads\`]->>) {
  c-[e:\`List Entry\`]-> {
    return e.\`List Score\`
  }
}

listen to crm-[:\`List Entry — Hot Leads\`]->-[c:Changes WHERE c.Field == "${field}"]-> fire scored
`;

  const errors = async (source: string) =>
    checkSourceInRust(source, await snapshot(), { languageVersion: LANGUAGE_VERSION })
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => `${d.code} ${d.message}`);

  it('checks clean naming one of the list’s fields, and refuses a field the list lacks', async () => {
    expect(await errors(program('List Score'))).toEqual([]);
    expect((await errors(program('Lst Score'))).join('\n')).toMatch(/MOV_ENUM_UNKNOWN_VALUE[\s\S]*Lst Score/);
  });

  const valued = (where: string) =>
    program('List Score').replace('WHERE c.Field == "List Score"', `WHERE ${where}`);

  it("checks a change's value against the record's own field, and how it changed against set, changed and cleared", async () => {
    expect(await errors(valued('c.`Field Change` == "set" AND exists(c.Current) AND c.Current.`List Score` > 3'))).toEqual([]);
    expect(await errors(valued('exists(c.Previous) AND c.Previous.Tags CONTAINS "fintech"'))).toEqual([]);
    expect((await errors(valued('exists(c.Current) AND c.Current.`Lst Score` > 3'))).join('\n')).toMatch(/Lst Score/);
    expect((await errors(valued('c.`Field Change` == "cleard"'))).join('\n')).toMatch(/MOV_ENUM_UNKNOWN_VALUE[\s\S]*cleard/);
  });

  it("checks a listen on an opportunity list's column", async () => {
    const deals = program('List Score').replace(/Hot Leads/g, 'Deals').replace('e.`List Score`', 'e.`Deal Stage`').replace('c.Field == "List Score"', 'c.Field == "Deal Stage"');
    expect(await errors(deals)).toEqual([]);
  });
});

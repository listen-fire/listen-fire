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
      key: '13',
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
      key: '7101',
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
    expect(stage).toMatchObject({ key: '7101', landing: { recordType: 'OrganizationChange', fields: { Kind: 'updated', Field: 'Stage' } } });
    const opportunity = (await adapter.preprocessInbound({ raw: fieldValue('opportunity.updated', { id: 700, name: 'Acme — Series A' }) })).arrivals[0];
    expect(opportunity).toMatchObject({ landing: { recordType: 'OpportunityChange' }, parents: [{ recordType: 'Opportunity', fields: { Name: 'Acme — Series A' } }] });
  });

  it('a list_entry event types the entry by the list its body names', async () => {
    const { adapter } = makeAdapter();
    const added = (await adapter.preprocessInbound({ raw: fieldValue('list_entry.created', { id: 13, list_id: 556, entity_id: 7201, entity_type: 0, created_at: '2026-10-02T00:00:00Z' }) })).arrivals[0];
    expect(added).toMatchObject({ key: '13', landing: { recordType: 'List Entry Change — People List', fields: { Kind: 'created' } }, occurredAt: '2026-10-02T00:00:00Z' });
  });

  it('a note, a reminder, a list, a field value on a list the workspace does not list, and junk run nothing', async () => {
    const { adapter } = makeAdapter();
    for (const raw of [
      fieldValue('note.created', { id: 500, content: 'hi' }),
      fieldValue('reminder.updated', { id: 800 }),
      fieldValue('list.created', { id: 9 }),
      fieldValue('field_value.updated', { id: 1, field_id: 999, entity_type: 1, entity_id: 7101, list_entry_id: 13, value: 'x' }),
      { nonsense: true },
    ]) {
      expect(await adapter.preprocessInbound({ raw })).toEqual({ events: [], arrivals: [] });
    }
  });
});

describe('@lf/affinity waits, walks and subscribes on Changes', () => {
  it('keys a wait on a record’s Changes by the record’s id, and knows no other edge', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: '7101' }, { recordId: '13' }] })).toEqual([{ key: '7101' }, { key: '13' }]);
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
});

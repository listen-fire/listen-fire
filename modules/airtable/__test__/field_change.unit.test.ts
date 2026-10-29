// A listen on one Airtable field: "when Stage becomes Interview". Airtable is
// asked for the previous cell values; each record change names the fields that
// changed and carries what they held before; the event node exposes both
// (`Changed Fields`, and an `Old Record` edge typed like the table); and the
// listen's `field` / `becomes` config keeps the listen from firing on any other
// edit.
//
// The end to end runs on the engine package's own path, in process: the real
// adapter drains a fake payload feed, the engine's listen gate decides which
// events reach the listen, and the engine runs the movement against a catalog
// projected from the real adapter. listen-fire cannot register an Airtable webhook yet
// (it sends no subscription scope), so this is the most real path in this
// repository.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { LANGUAGE_VERSION, mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';
import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import {
  constructionArgsOf,
  instanceSchemaFromDescriptors,
  makeUnstablePosition,
  positionData,
  triggerConfigVocabulary,
} from 'movement-engine/public/catalog';
import { eventMatchesTriggerScope, triggerEventOf } from 'movement-engine/public/inbound';
import { runMovement } from 'movement-engine/public/movement-engine';
import { credentialIdsFor, makeTestHost } from 'movement-engine/public/testing';

import { AirtableAdapter } from '../adapter';
import { AirtableAPIClient } from '../api_client';
import { AIRTABLE_MANIFEST } from '../manifest';
import { testFiles } from '../testing';
import { AIRTABLE_SUBSCRIBABLE_EVENTS, airtableEventTypes, eventsFromPayload, type AirtableEventData } from '../webhook';

const BASE = 'appHIRE01';
const CANDIDATES = 'tblCAND01';
const INTERVIEWS = 'tblINTV01';

const candidatesTable = () => ({
  id: CANDIDATES,
  name: 'Candidates',
  primaryFieldId: 'fldName',
  fields: [
    { id: 'fldName', name: 'Name', type: 'singleLineText' as const },
    {
      id: 'fldStage',
      name: 'Stage',
      type: 'singleSelect' as const,
      options: { choices: [{ id: 'selA', name: 'Applied' }, { id: 'selI', name: 'Interview' }, { id: 'selR', name: 'Rejected' }] },
    },
    {
      id: 'fldSkills',
      name: 'Skills',
      type: 'multipleSelects' as const,
      options: { choices: [{ id: 'selT', name: 'TypeScript' }, { id: 'selU', name: 'Rust' }] },
    },
  ],
});

const interviewsTable = () => ({
  id: INTERVIEWS,
  name: 'Interviews',
  primaryFieldId: 'fldCandidate',
  fields: [
    { id: 'fldCandidate', name: 'Candidate', type: 'singleLineText' as const },
    { id: 'fldFrom', name: 'From', type: 'singleLineText' as const },
    { id: 'fldChanged', name: 'Changed', type: 'multilineText' as const },
  ],
});

/** A select cell as a webhook payload carries it (Airtable's cell format V2):
 *  an object, not the plain name the REST API returns. */
const choice = (id: string, name: string) => ({ id, name, color: 'blueLight2' });

/** One record update in a payload, with the previous values Airtable sends
 *  when the webhook asked for them. */
function updated(input: { record: string; current: Record<string, unknown>; previous?: Record<string, unknown> }) {
  return {
    timestamp: '2026-10-27T09:00:00.000Z',
    changedTablesById: {
      [CANDIDATES]: {
        changedRecordsById: {
          [input.record]: {
            current: { cellValuesByFieldId: input.current },
            ...(input.previous !== undefined ? { previous: { cellValuesByFieldId: input.previous } } : {}),
          },
        },
      },
    },
  };
}

const fields = () =>
  new Map([
    [CANDIDATES, new Map(candidatesTable().fields.map((f) => [f.id, { name: f.name, type: f.type }]))],
  ]);

function eventsOf(payload: ReturnType<typeof updated> | Record<string, unknown>): DiscriminableEvent[] {
  return eventsFromPayload({
    baseId: BASE,
    fieldsByTable: fields(),
    tableNamesById: new Map([[CANDIDATES, 'Candidates']]),
    payload: payload as Parameters<typeof eventsFromPayload>[0]['payload'],
  });
}

/** The three edits the done-criterion names, plus a Skills edit. */
const STAGE_TO_INTERVIEW = updated({
  record: 'recADA',
  current: { fldStage: choice('selI', 'Interview') },
  previous: { fldStage: choice('selA', 'Applied') },
});
const NAME_ONLY = updated({ record: 'recBOB', current: { fldName: 'Bob Smith' }, previous: { fldName: 'Bob' } });
const STAGE_TO_REJECTED = updated({
  record: 'recCY',
  current: { fldStage: choice('selR', 'Rejected') },
  previous: { fldStage: choice('selA', 'Applied') },
});

const LISTEN = { base: BASE, table: CANDIDATES, events: ['record.updated'], field: 'Stage', becomes: 'Interview' };

describe('createWebhook asks Airtable for previous cell values and every current one', () => {
  it('sends includes.includePreviousCellValues and includeCellValuesInFieldIds beside the filters', async () => {
    const sent: unknown[] = [];
    const client = new AirtableAPIClient({
      tokens: { accessToken: async () => 'token', refresh: async () => undefined },
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: 'achNEW', macSecretBase64: 'c2VjcmV0' }), { status: 200 });
      }) as typeof fetch,
    });
    await client.createWebhook({ baseId: BASE, notificationUrl: 'https://example.test/hook', tableId: CANDIDATES, changeTypes: ['update'] });
    expect(sent).toEqual([
      {
        notificationUrl: 'https://example.test/hook',
        specification: {
          options: {
            filters: { dataTypes: ['tableData'], changeTypes: ['update'], recordChangeScope: CANDIDATES },
            includes: { includePreviousCellValues: true, includeCellValuesInFieldIds: 'all' },
          },
        },
      },
    ]);
  });
});

describe('a record change names its changed fields and their previous values', () => {
  it('an update carries the changed field names, the new values and the previous ones, by field name', () => {
    const [event] = eventsOf(STAGE_TO_INTERVIEW);
    const data = event.payload as AirtableEventData;
    expect(data['Changed Fields']).toEqual(['Stage']);
    // A select reads as its choice's name — the enum's value — not as
    // Airtable's webhook object.
    expect(data.fields).toEqual({ Stage: 'Interview' });
    expect(data.previous).toEqual({ Stage: 'Applied' });
    expect(event.changedFields).toEqual(['Stage']);
  });

  it('a multiple select reads as its choices\' names, now and before', () => {
    const [event] = eventsOf(
      updated({
        record: 'recADA',
        current: { fldSkills: [choice('selT', 'TypeScript'), choice('selU', 'Rust')] },
        previous: { fldSkills: [choice('selT', 'TypeScript')] },
      }),
    );
    const data = event.payload as AirtableEventData;
    expect(data.fields).toEqual({ Skills: ['TypeScript', 'Rust'] });
    expect(data.previous).toEqual({ Skills: ['TypeScript'] });
  });

  it('a webhook made before previous values were asked for still names what changed, with nothing before', () => {
    const [event] = eventsOf(updated({ record: 'recADA', current: { fldStage: choice('selI', 'Interview') } }));
    const data = event.payload as AirtableEventData;
    expect(data['Changed Fields']).toEqual(['Stage']);
    expect(data.previous).toEqual({});
  });

  it('a created record changed every field it was given; a deleted one changed none', () => {
    const [created, deleted] = eventsOf({
      changedTablesById: {
        [CANDIDATES]: {
          createdRecordsById: { recNEW: { cellValuesByFieldId: { fldName: 'Dee', fldStage: choice('selA', 'Applied') } } },
          destroyedRecordIds: ['recGONE'],
        },
      },
    });
    expect((created.payload as AirtableEventData)['Changed Fields']).toEqual(['Name', 'Stage']);
    expect((created.payload as AirtableEventData).previous).toEqual({});
    expect((deleted.payload as AirtableEventData)['Changed Fields']).toEqual([]);
  });
});

describe('a change carries the whole row when the webhook asked for every cell', () => {
  const adapter = () => new AirtableAdapter({ tenant: 'team-air-fieldchange-row', client: noClient, files: testFiles });
  const STAGE_WITH_ROW = {
    timestamp: '2026-10-27T09:00:00.000Z',
    changedTablesById: {
      [CANDIDATES]: {
        changedRecordsById: {
          recADA: {
            current: { cellValuesByFieldId: { fldStage: choice('selI', 'Interview') } },
            previous: { cellValuesByFieldId: { fldStage: choice('selA', 'Applied') } },
            unchanged: { cellValuesByFieldId: { fldName: 'Ada Lovelace', fldSkills: [choice('selT', 'TypeScript')] } },
          },
        },
      },
    },
  };

  it('the row holds every field, and what changed is still only what changed', () => {
    const [event] = eventsOf(STAGE_WITH_ROW);
    const data = event.payload as AirtableEventData;
    expect(data.fields).toEqual({ Name: 'Ada Lovelace', Skills: ['TypeScript'], Stage: 'Interview' });
    expect(data['Changed Fields']).toEqual(['Stage']);
    expect(event.changedFields).toEqual(['Stage']);
    expect(data.previous).toEqual({ Stage: 'Applied' });
  });

  it('the `Record` edge reads the fields the change did not touch, and the row\'s id as `Id`', async () => {
    const [event] = eventsOf(STAGE_WITH_ROW);
    const position = makeUnstablePosition({ adapterType: 'airtable', recordType: 'Record Change', data: event.payload });
    const [landed] = await adapter().getRelated({ position, fieldId: 'Record', direction: 'outgoing' });
    const read = (fieldId: string) => adapter().getFieldValue({ position: landed.position, fieldId });
    expect(await read('Name')).toBe('Ada Lovelace');
    expect(await read('Stage')).toBe('Interview');
    expect(await read('Id')).toBe('recADA');
  });

  it('a table describes its rows\' id as a read-only `Id`, unless the table has a field of that name', async () => {
    const { client } = fakeHiring([]);
    const hiring = new AirtableAdapter({ tenant: `team-air-id-${Math.random()}`, client: async () => client, files: testFiles });
    const described = await hiring.describe('Candidates');
    expect(described?.fields.find((f) => f.displayName === 'Id')).toMatchObject({ kind: 'string', writable: false });
  });
});

describe('a webhook registered before it asked for every cell is registered anew', () => {
  function subscriptions(specification: Record<string, unknown>) {
    const calls: string[] = [];
    const client = {
      listWebhooks: async ({ baseId }: { baseId: string }) => (calls.push(`list ${baseId}`), [{ id: 'achOLD', specification }]),
      deleteWebhook: async ({ webhookId }: { webhookId: string }) => void calls.push(`delete ${webhookId}`),
      createWebhook: async () => (calls.push('create'), { webhookId: 'achNEW', macSecretBase64: 'c2VjcmV0' }),
    };
    const adapter = new AirtableAdapter({ tenant: `team-air-respec-${Math.random()}`, client: async () => client as unknown as AirtableAPIClient, files: testFiles });
    const ensure = () =>
      adapter.ensureEventSubscription({
        events: ['record.updated'],
        callbackUrl: 'https://example.test/hook',
        scope: { base: BASE, table: CANDIDATES },
        current: { externalId: 'achOLD', events: ['record.updated'] },
      });
    return { calls, ensure };
  }

  it('one that asked only for previous values is replaced', async () => {
    const { calls, ensure } = subscriptions({ options: { filters: {}, includes: { includePreviousCellValues: true } } });
    expect(await ensure()).toEqual({ externalId: 'achNEW', secret: 'c2VjcmV0' });
    expect(calls).toEqual([`list ${BASE}`, 'delete achOLD', 'create']);
  });

  it('one that asked for every cell is kept', async () => {
    const { calls, ensure } = subscriptions({ options: { filters: {}, includes: { includePreviousCellValues: true, includeCellValuesInFieldIds: 'all' } } });
    expect(await ensure()).toBeUndefined();
    expect(calls).toEqual([`list ${BASE}`]);
  });
});

describe('the event node exposes the changed fields and the record as it was', () => {
  const adapter = () => new AirtableAdapter({ tenant: 'team-air-fieldchange-node', client: noClient, files: testFiles });

  it('describes `Changed Fields` as a list of names, and an `Old Record` edge to the same table as `Record`', async () => {
    const described = await adapter().describe('Record Change');
    expect(described?.fields.find((f) => f.displayName === 'Changed Fields')).toMatchObject({ kind: 'string', cardinality: 'many', writable: false });
    const [record, old] = [described?.references.find((r) => r.name === 'Record'), described?.references.find((r) => r.name === 'Old Record')];
    expect(old).toMatchObject({ targetTypeId: record?.targetTypeId, cardinality: 'one', writable: false });
    // The event is ABOUT the record as it is now; the old record is a view of
    // it, never the subject a listen's `fields:` names columns of.
    expect(old?.subject).toBeUndefined();
  });

  it('the `Old Record` edge mints the row as it was: typed by its table, holding the previous values, never fetched', async () => {
    const [event] = eventsOf(STAGE_TO_INTERVIEW);
    const position = makeUnstablePosition({ adapterType: 'airtable', recordType: 'Record Change', data: event.payload });
    for (const fieldId of ['Old Record', 'oldRecord']) {
      const [landed] = await adapter().getRelated({ position, fieldId, direction: 'outgoing' });
      expect(landed.position.recordType).toBe('Candidates');
      expect(positionData(landed.position)).toEqual({ Stage: 'Applied' });
      // A past state cannot be re-read: it is not the live row's identity.
      expect(landed.position.identity.kind).toBe('unstable');
    }
  });
});

describe('a listen scoped to one field, and to the value it becomes', () => {
  it('the manifest declares `field` and `becomes`, so the checker accepts them on a listen', () => {
    const vocabulary = triggerConfigVocabulary(AIRTABLE_MANIFEST);
    expect(vocabulary.triggerConfig).toEqual(expect.arrayContaining(['field', 'becomes']));
    expect(vocabulary.triggerConfigRequired ?? []).not.toContain('field');
    expect(vocabulary.triggerConfigRequired ?? []).not.toContain('becomes');
  });

  const admits = (payload: ReturnType<typeof updated> | Record<string, unknown>, config: Record<string, unknown>) =>
    eventsOf(payload).map((event) => eventMatchesTriggerScope(event, config));

  it('`field` alone: fires when that field changed, on whatever it became, and not on an unrelated edit', () => {
    const config = { ...LISTEN, becomes: undefined };
    expect(admits(STAGE_TO_INTERVIEW, config)).toEqual([true]);
    expect(admits(STAGE_TO_REJECTED, config)).toEqual([true]);
    expect(admits(NAME_ONLY, config)).toEqual([false]);
  });

  it('`becomes`: fires only when the field changed TO the value', () => {
    expect(admits(STAGE_TO_INTERVIEW, LISTEN)).toEqual([true]);
    expect(admits(STAGE_TO_REJECTED, LISTEN)).toEqual([false]);
    expect(admits(NAME_ONLY, LISTEN)).toEqual([false]);
  });

  it('`becomes`: a field that already held the value did not become it', () => {
    const same = updated({
      record: 'recADA',
      current: { fldStage: choice('selI', 'Interview') },
      previous: { fldStage: choice('selI', 'Interview') },
    });
    expect(admits(same, LISTEN)).toEqual([false]);
  });

  it('`becomes` over a created record: created holding the value is becoming it', () => {
    const created = {
      changedTablesById: {
        [CANDIDATES]: { createdRecordsById: { recNEW: { cellValuesByFieldId: { fldStage: choice('selI', 'Interview') } } } },
      },
    };
    expect(admits(created, { ...LISTEN, events: ['record.created', 'record.updated'] })).toEqual([true]);
  });

  it('a listen with neither key still hears every edit of its table', () => {
    expect(admits(NAME_ONLY, { base: BASE, table: CANDIDATES })).toEqual([true]);
  });
});

// ── end to end: the engine's run path, the adapter in process ───────────────

async function noClient(): Promise<never> {
  throw new Error('this test replaces the client');
}

/** A fake Airtable client: the Hiring base's metadata, a webhook payload feed,
 *  and the rows written. */
function fakeHiring(feed: unknown[]) {
  const created: Array<{ baseId: string; tableId: string; fields: Record<string, unknown> }> = [];
  const client = {
    listBases: async () => [{ id: BASE, name: 'Hiring' }],
    listTables: async ({ baseId }: { baseId: string }) => (baseId === BASE ? [candidatesTable(), interviewsTable()] : []),
    listRecords: async () => [],
    listPayloads: async ({ cursor }: { cursor?: number }) => {
      const from = (cursor ?? 1) - 1;
      return { payloads: feed.slice(from), cursor: feed.length + 1, mightHaveMore: false };
    },
    createRecord: async (args: { baseId: string; tableId: string; fields: Record<string, unknown> }) => {
      created.push(args);
      return { id: `recNEW${created.length}`, fields: args.fields };
    },
  };
  return { client: client as unknown as AirtableAPIClient, created };
}

/**
 * The instance schema the platform's catalog hands the checker for a
 * base-positioned connection: the real adapter's entries and descriptors,
 * through the engine's projection — and then the one step the platform's
 * catalog adds, which lives in the platform repository: the address a
 * signature names (`table`) gets positions of its own, one per `action`, each a
 * copy of the event node whose edges onto the unnarrowed `Table` land on the
 * table it names (lf-platform listen_narrowing.ts, `graftAddress`; listen-fire's port is
 * crates/lf/src/listen_narrowing.rs). That is what makes both `Record` and
 * `Old Record` typed as `Candidates`, and what the listen's `field` is checked
 * against. Emulated here, by the same rule.
 */
async function hiringSchema(adapter: AirtableAdapter): Promise<InstanceSchema> {
  const entries = await adapter.listEntryPoints();
  const described = await Promise.all(entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const));
  const event = await adapter.describe('Record Change');
  const { schema } = instanceSchemaFromDescriptors({
    adapterType: 'airtable',
    entries,
    descriptors: new Map([
      ...described.flatMap(([id, d]) => (d ? [[id, d] as const] : [])),
      ...(event ? [[event.typeId, event] as const] : []),
    ]),
    supportsInPlaceUpdate: true,
  });
  const eventNode = schema.positions['Record Change'];
  if (eventNode === undefined) throw new Error('test: the projection minted no Record Change position');
  const retargeted = Object.fromEntries(
    Object.entries(eventNode.edges).map(([name, edge]) => [name, edge.target === 'Table' ? { ...edge, target: 'Candidates' } : edge]),
  );
  const keyOf = (pins: Array<[string, string]>) => JSON.stringify(['Record Change', pins]);
  const grafted = Object.fromEntries(
    AIRTABLE_SUBSCRIBABLE_EVENTS.map((action) => [keyOf([['action', action], ['table', CANDIDATES]]), { ...eventNode, edges: retargeted }]),
  );
  return {
    ...schema,
    eventNarrowingKeys: ['table'],
    positions: { ...schema.positions, ...grafted },
    unions: { ...schema.unions, [keyOf([['table', CANDIDATES]])]: Object.keys(grafted) },
  };
}

const PROGRAM = `import { airtable } from adapters
import { acme } from credentials

hiring = connect airtable using acme { base: "Hiring" }

function schedule_interview(change: <hiring-[e:\`Record Change\` WHERE e.table == "${CANDIDATES}"]->>) {
  was = change-[:\`Old Record\`]->.Stage
  now = change-[:Record]->.Stage
  if (was != "Interview" && now == "Interview") {
    write hiring-[:Interviews]-> {
      Candidate: change.record
      From: was
      Changed: Text.join(change.\`Changed Fields\`, ", ")
    }
  }
}

listen to hiring { base: "${BASE}", table: "${CANDIDATES}", events: ["record.updated"], field: "Stage", becomes: "Interview" } fire schedule_interview
`;

async function deliver(input: { feed: unknown[]; source?: string }) {
  const { client, created } = fakeHiring(input.feed);
  const adapter = new AirtableAdapter({ tenant: `team-air-e2e-${Math.random()}`, client: async () => client, files: testFiles, base: 'Hiring' });
  const catalog = mockCatalogSnapshot({
    adapters: {
      airtable: {
        constructionArgs: constructionArgsOf(AIRTABLE_MANIFEST),
        ...triggerConfigVocabulary(AIRTABLE_MANIFEST),
        schema: await hiringSchema(adapter),
      },
    },
    credentials: { acme: { adapters: ['airtable'] } },
  });

  // The inbound half, as a host runs it: the ping pulls the feed, each event
  // meets the listen's gate, and only an admitted one becomes a run.
  const { events } = await adapter.preprocessInbound!({ raw: { base: { id: BASE }, webhook: { id: 'achHIRE' } } });
  const admitted = events.filter((event) => eventMatchesTriggerScope(event, LISTEN));
  const runs = [];
  for (const event of admitted) {
    const { triggerEvent } = triggerEventOf({
      pipelineInputId: 'pi-hiring',
      adapterType: 'airtable',
      triggerType: 'webhook',
      event,
      eventTypes: airtableEventTypes(),
      now: new Date('2026-10-27T09:00:00.000Z'),
    });
    runs.push(
      await runMovement({
        source: input.source ?? PROGRAM,
        event: triggerEvent,
        teamId: tenantIdOf('00000000-0000-0000-0000-0000000000b2'),
        catalog,
        credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
        languageVersion: LANGUAGE_VERSION,
        host: makeTestHost({ adapters: { resolve: () => adapter } }),
      }),
    );
  }
  return { events, admitted, runs, created };
}

describe('end to end: "when Stage becomes Interview", on the engine run path', () => {
  it('runs once, for the change to Interview — not for an unrelated edit, nor for Stage changing to something else', async () => {
    const { events, admitted, created } = await deliver({ feed: [NAME_ONLY, STAGE_TO_INTERVIEW, STAGE_TO_REJECTED] });
    expect(events).toHaveLength(3);
    expect(admitted.map((e) => e.externalId)).toEqual(['recADA']);
    // The movement read the previous Stage and the changed fields off the
    // event, and wrote them.
    expect(created).toEqual([
      { baseId: BASE, tableId: INTERVIEWS, fields: { fldCandidate: 'recADA', fldFrom: 'Applied', fldChanged: 'Stage' } },
    ]);
  });

  it('the previous Stage is typed as the Stage enum: comparing it to a choice Stage lacks is refused at the check', async () => {
    const typo = PROGRAM.replace('was != "Interview"', 'was != "Interveiw"');
    await expect(deliver({ feed: [STAGE_TO_INTERVIEW], source: typo })).rejects.toThrow(/MOV_ENUM_UNKNOWN_VALUE .*Interveiw/);
  });

  it('a signature that names no table leaves the row undescribed, so reading its Stage is refused at the check', async () => {
    const unaddressed = PROGRAM.replace(/<hiring-\[e:`Record Change` WHERE [^\]]*\]->>/, '<hiring-[:`Record Change`]->>');
    expect(unaddressed).not.toBe(PROGRAM);
    await expect(deliver({ feed: [STAGE_TO_INTERVIEW], source: unaddressed })).rejects.toThrow(/MOV_UNDESCRIBED_POSITION .*name its table in the movement's signature/);
  });
});

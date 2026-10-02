// Engine coverage for graph literals — `graph<Shape> { … }` / `graph { … }`.
//
// A graph literal builds a LOCAL GRAPH: the same run-local node a node literal
// makes, so paths, WHERE, writes and links on it are the local graph's own. A
// walk inside it is a SNAPSHOT — a walk with a field body builds one child per
// record, a bare walk copies each record — and a file is copied as the lazy
// handle it is. Mirrors the harness of node_synthesis.unit.test.ts.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { runMovement, resumeMovement } from '../run';
import type { ParkSink } from '../run';
import type { CallbackSink } from '../callback_sink';
import type { ParkedScopeState } from '../serialize';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  RESOURCES_REFERENCE_FIELD_ID,
  type Adapter,
  type RuntimeCapabilities,
  type Resource,
} from '../../translation_graph/adapter';
import type { FileRef } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { makeUnstablePosition, positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000020' as TeamId;

// ── Fake adapters ────────────────────────────────────────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface RecordedWrite {
  recordType: string;
  externalId?: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(
  adapterType: string,
  opts: {
    resources?: Resource[];
    related?: Record<string, Array<Record<string, unknown>>>;
    /** Answer a hop FRESHLY per call — how a source that changes between two
     *  reads is spelled (a lazy walk must see the change; an eager one must
     *  not). Consulted before `related`; `relatedCalls` counts the hops. */
    relatedFn?: (fieldId: string, call: number) => Array<Record<string, unknown>> | undefined;
  } = {},
): {
  adapter: Adapter;
  creates: RecordedWrite[];
  updates: RecordedWrite[];
  relatedCalls: { count: number };
} {
  const creates: RecordedWrite[] = [];
  const updates: RecordedWrite[] = [];
  const relatedCalls = { count: 0 };
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated({ fieldId }) {
      relatedCalls.count += 1;
      const fresh = opts.relatedFn?.(fieldId, relatedCalls.count);
      if (fresh) {
        return fresh.map((data) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data }),
        }));
      }
      if (fieldId === RESOURCES_REFERENCE_FIELD_ID && opts.resources) {
        return opts.resources.map((resource) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data: resource }),
        }));
      }
      for (const [edge, records] of Object.entries(opts.related ?? {})) {
        if (edge !== fieldId) continue;
        return records.map((data) => ({
          position: makeUnstablePosition({ adapterType, recordType: null, data }),
        }));
      }
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return {
        adapterType,
        externalId: `ext-${adapterType}-${creates.length}`,
        data: {},
      };
    },
    async updateRecord(input) {
      updates.push({
        recordType: input.recordType,
        externalId: input.externalId,
        fields: input.fields,
      });
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates, relatedCalls };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

function webhookEvent(adapterType: string, payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-movement-calls',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}


// ── Catalog / fixtures ───────────────────────────────────────────────────────

// The inbox is TYPED here (the thin fixture leaves email untyped), so a graph
// literal's copy has a field list to copy and its shape check has teeth.
const catalog = staticCatalogFromManifests({
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    team_drive: { adapters: ['dropbox'] },
    acme_main: { adapters: ['attio'] },
  },
  instanceSchemas: {
    email: {
      positions: {
        message: {
          properties: { subject: 'text', text: 'text', payload: 'json' },
          edges: { files: { target: 'attachment', readable: true, sequenced: 'document' } },
        },
        attachment: {
          properties: { filename: 'text', contentType: 'text', data: 'file' },
          edges: { versions: { target: 'version', readable: true } },
        },
        version: { properties: { label: 'text' }, edges: {} },
      },
      collections: { message: { target: 'message' } },
      writableRoots: {},
    },
  },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  team_drive: 'cred-dropbox-1',
  acme_main: 'cred-attio-1',
};

const PRELUDE = [
  'import { email, dropbox, attio } from adapters',
  'import { team_drive, acme_main } from credentials',
  '',
  'inbox = email()',
  '',
].join('\n');

/** A fake callback sink — the cheapest REAL park: minting a callback captures
 *  the enclosing scope through the same serialiser a parked ask writes. */
function makeFakeCallbackSink() {
  const mints: Array<{ id: string; state: ParkedScopeState }> = [];
  const sink = {
    async mint(input: { state: ParkedScopeState }) {
      const id = `cb_fake${mints.length + 1}`;
      mints.push({ id, state: input.state });
      return { id, url: `https://api.test/api/cb/${id}` };
    },
    async calls() {
      return [];
    },
    async correlateAwait() {},
  } as unknown as CallbackSink;
  return { sink, mints };
}

interface RunAdapters {
  email: Adapter;
  attio?: Adapter;
  dropbox?: Adapter;
  callbacks?: { sink: CallbackSink };
  parkSink?: ParkSink;
}

function run(source: string, payload: Record<string, unknown>, adapters: RunAdapters):
  Promise<Awaited<ReturnType<typeof runMovement>>> {
  return runMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent('email', payload),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: makeResolver({
      email: adapters.email,
      ...(adapters.attio ? { attio: adapters.attio } : {}),
      ...(adapters.dropbox ? { dropbox: adapters.dropbox } : {}),
    }),
    ...(adapters.callbacks ? { callbackSink: adapters.callbacks.sink } : {}),
    ...(adapters.parkSink ? { parkSink: adapters.parkSink } : {}),
  });
}

/** The same movement, resumed from a parked leaf — the REAL resume path. */
function resume(
  source: string,
  payload: Record<string, unknown>,
  adapters: RunAdapters,
  state: ParkedScopeState,
): Promise<Awaited<ReturnType<typeof resumeMovement>>> {
  return resumeMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent('email', payload),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: makeResolver({
      email: adapters.email,
      ...(adapters.attio ? { attio: adapters.attio } : {}),
      ...(adapters.dropbox ? { dropbox: adapters.dropbox } : {}),
    }),
    state,
  });
}

function makeFakeParkSink(): {
  sink: ParkSink;
  timerParks: Array<{ address: string; state: ParkedScopeState }>;
} {
  const timerParks: Array<{ address: string; state: ParkedScopeState }> = [];
  const sink = {
    async commitTimerPark(input: { address: string; state: ParkedScopeState }) {
      timerParks.push({ address: input.address, state: input.state });
    },
    async recordJoin() {},
  } as unknown as ParkSink;
  return { sink, timerParks };
}


// ── Graph literals ───────────────────────────────────────────────────────────

const MESSAGE = [
  'node Message: "a message in a common format" {',
  '  text: <text>',
  '  node attachment: "each file attached" {',
  '    name: <text | null>',
  '    type: <text>',
  '    file: <file>',
  '  }',
  '}',
  '',
  'movement from_email(m: <inbox-[:message]->>) {',
  '  return graph<Message> {',
  '    text: m.subject,',
  '    attachment: m-[a:files]-> { name: a.filename, type: a.contentType, file: a.`data` },',
  '  }',
  '}',
  '',
].join('\n');

function attachment(filename: string, contentType: string) {
  return {
    filename,
    contentType,
    data: {
      __brand: 'FileRef',
      name: filename,
      contentType,
      retrieve: async () => {
        throw new Error('test: building a graph must never pull the bytes');
      },
    } as unknown as FileRef,
  };
}

describe('graph<Shape> — the worked example', () => {
  it('builds a Message from an email; the caller reads it by path, WHERE and dot', async () => {
    const deck = attachment('deck.pdf', 'application/pdf');
    const photo = attachment('photo.png', 'image/png');
    const email = makeFakeAdapter('email', { related: { files: [deck, photo] } });
    const dropbox = makeFakeAdapter('dropbox');

    const result = await run(
      MESSAGE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  drive = dropbox(credentials: team_drive)',
          '  m = from_email(m: msg)',
          '  m-[a:attachment WHERE a.type = "application/pdf"]-> {',
          '    write drive-[:file]-> {',
          '      filename: m.text',
          '      data: a.file',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 'Series A' },
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    // The WHERE kept the one PDF, and its file is the SAME handle the source
    // produced: a file is copied as the lazy handle it is, nothing downloads.
    expect(dropbox.creates).toHaveLength(1);
    expect(dropbox.creates[0].fields).toEqual({ filename: 'Series A', data: deck.data });
    // The trail survives the snapshot: the copied file still cites its source.
    expect(result.writes.at(-1)?.provenance.data).toEqual([
      { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'data' },
    ]);
  });

  it('a WHERE over the result in an expression reads the kept records', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('a.pdf', 'application/pdf'), attachment('b.png', 'image/png')] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      MESSAGE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  m = from_email(m: msg)',
          '  write crm-[:companies]-> {',
          '    name: m.text',
          '    summary: COALESCE(ONLY(m-[a:attachment WHERE a.type = "application/pdf"]->.name), "none")',
          '  }',
          '}',
        ].join('\n'),
      { subject: 'Acme' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates).toEqual([
      { recordType: 'company', fields: { name: 'Acme', summary: 'a.pdf' } },
    ]);
  });
});

describe('a bare walk copies the records — a snapshot, never a reference', () => {
  const ARCHIVE = [
    'node Archive {',
    '  subject: <text>',
    '  node files {',
    '    filename: <text>',
    '    data: <file>',
    '  }',
    '}',
    '',
  ].join('\n');

  it('copies the shape\'s fields once; later reads never reach the source again', async () => {
    const email = makeFakeAdapter('email', { related: { files: [attachment('x.pdf', 'application/pdf')] } });
    const attio = makeFakeAdapter('attio');

    await run(
      ARCHIVE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
          '  g-[f:files]-> {',
          '    write crm-[:companies]-> { name: f.filename }',
          '  }',
          '  g-[f:files]-> {',
          '    write crm-[:companies]-> { name: f.filename }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 's' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['x.pdf', 'x.pdf']);
    // ONE hop to the source: the copy is read from the local graph after that.
    expect(email.relatedCalls.count).toBe(1);
  });

  it('a write into the local graph stays in the run — the source sees nothing', async () => {
    const email = makeFakeAdapter('email', { related: { files: [attachment('x.pdf', 'application/pdf')] } });
    const attio = makeFakeAdapter('attio');

    const result = await run(
      ARCHIVE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
          '  write g-[:files]-> { unique by (filename), filename: "y.pdf", data: msg-[:files]->.data }',
          '  g-[f:files]-> {',
          '    write crm-[:companies]-> { name: f.filename }',
          '  }',
          '}',
        ].join('\n'),
      { subject: 's' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(email.creates).toEqual([]);
    expect(email.updates).toEqual([]);
    expect(attio.creates.map((c) => c.fields.name).sort()).toEqual(['x.pdf', 'y.pdf']);
  });
});

describe('copy depth, the bare copy without a shape, and the typed empty graph', () => {
  it('a nested node in the shape is followed through the source\'s edge of the same name', async () => {
    const email = makeFakeAdapter('email', {
      related: { files: [attachment('x.pdf', 'application/pdf')], versions: [{ label: 'v1' }, { label: 'v2' }] },
    });
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Archive {',
        '  subject: <text>',
        '  node files {',
        '    filename: <text>',
        '    node versions {',
        '      label: <text>',
        '    }',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph<Archive> { subject: msg.subject, files: msg-[:files]-> }',
        '  g-[f:files]->-[v:versions]-> {',
        '    write crm-[:companies]-> { name: f.filename, summary: v.label }',
        '  }',
        '}',
      ].join('\n'),
      { subject: 's' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'x.pdf', summary: 'v1' },
      { name: 'x.pdf', summary: 'v2' },
    ]);
    // Two hops to the source — files, then versions — both at the literal.
    expect(email.relatedCalls.count).toBe(2);
  });

  it('without a shape, a bare walk copies the records\' own fields', async () => {
    const deck = attachment('deck.pdf', 'application/pdf');
    const email = makeFakeAdapter('email', { related: { files: [deck] } });
    const dropbox = makeFakeAdapter('dropbox');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  drive = dropbox(credentials: team_drive)',
        '  g = graph { files: msg-[:files]-> }',
        '  g-[f:files]-> {',
        '    write drive-[:file]-> { filename: f.filename, data: f.data }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, dropbox: dropbox.adapter },
    );

    expect(dropbox.creates.map((c) => c.fields)).toEqual([{ filename: 'deck.pdf', data: deck.data }]);
  });

  it('graph<Shape> {} starts every child empty, and a write fills it', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'node Detailed {',
        '  note: <text | null>',
        '  node part {',
        '    label: <text>',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph<Detailed> {}',
        '  g-[p:part]-> {',
        '    write crm-[:companies]-> { name: "before" }',
        '  }',
        '  write g-[:part]-> { unique by (label), label: "one" }',
        '  g-[p:part]-> {',
        '    write crm-[:companies]-> { name: p.label }',
        '  }',
        '}',
      ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['one']);
  });
});

describe('graph { … } and spreads', () => {
  it('without a shape, the literal is its own type and nested bodies are children', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  crm = attio(credentials: acme_main)',
        '  g = graph { title: msg.subject, parts: [{ label: "one" }, { label: "two" }] }',
        '  g-[p:parts]-> {',
        '    write crm-[:companies]-> { name: g.title, summary: p.label }',
        '  }',
        '}',
      ].join('\n'),
      { subject: 'T' },
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'T', summary: 'one' },
      { name: 'T', summary: 'two' },
    ]);
  });

  const NOTE = ['node Note {', '  text: <text>', '  node tag {', '    label: <text>', '  }', '}', ''].join('\n');

  it('a spread map becomes the graph; the shape decides which keys are children', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  v = { text: "from a map", tag: [{ label: "a" }, { label: "b" }] }',
          '  g = graph<Note> { ...v }',
          '  g-[t:tag]-> {',
          '    write crm-[:companies]-> { name: g.text, summary: t.label }',
          '  }',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'from a map', summary: 'a' },
      { name: 'from a map', summary: 'b' },
    ]);
  });

  it('a written entry wins over the spread\'s key', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    await run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  v = { text: "spread" }',
          '  g = graph<Note> { text: "written", ...v }',
          '  write crm-[:companies]-> { name: g.text }',
          '}',
        ].join('\n'),
      {},
      { email: email.adapter, attio: attio.adapter },
    );

    expect(attio.creates.map((c) => c.fields.name)).toEqual(['written']);
  });

  it('a map nobody could type is checked against the shape when the graph is built', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');

    const run1 = run(
      NOTE +
        [
          'movement intake(msg: <inbox-[:message]->>) {',
          '  crm = attio(credentials: acme_main)',
          '  v = msg.payload',
          '  g = graph<Note> { ...v }',
          '  write crm-[:companies]-> { name: g.text }',
          '}',
        ].join('\n'),
      { payload: { tag: [{ label: 'a' }] } },
      { email: email.adapter, attio: attio.adapter },
    );

    await expect(run1).rejects.toThrow(/doesn't fit it: it has no `text`/);
    expect(attio.creates).toEqual([]);
  });
});

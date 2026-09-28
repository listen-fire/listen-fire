// A node declaration reused as an extraction's shape, and a write body's
// spread, through the real engine: the prompt a declared node assembles must be
// the inline block's, and `...e` / `?...e` must write what the lines they stand
// for would.

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
// The TG-side parity run drives the PRODUCTION batcher, whose LlmClient
// wraps `anthropicChat` — the per-test responder is installed on this mock.
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

// A plugin that stored a document hands back the document's id; the invoker
// looks the stored object up. No database here — the lookup is answered from
// this table, which each test fills.
const storedDocuments = new Map<string, { id: string; description: string; objectUri: string }>();
jest.mock('../../document', () => ({
  DocumentService: {
    getById: jest.fn(async (id: string) => {
      const found = storedDocuments.get(id);
      if (!found) throw new Error(`Could not find document ${id}`);
      return found;
    }),
  },
}));

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { mockCatalog, type InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import type {
  LlmCallInput,
  LlmCallResult,
} from '../../translation_graph/engine/batched_extraction';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  ExternalRecordRef,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;


// ── Fake adapters (per run.unit.test.ts patterns) ───────────────────────────

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
    resolveCandidates?: (record: Record<string, unknown>) => ExternalRecordRef[];
    createResult?: (n: number) => { externalId: string; url?: string };
  } = {},
): { adapter: Adapter; creates: RecordedWrite[]; updates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const updates: RecordedWrite[] = [];
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
    async resolveEntity({ record }) {
      return { candidates: opts.resolveCandidates?.(record) ?? [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      const result = opts.createResult?.(creates.length + 1) ?? {
        externalId: `ext-${adapterType}-${creates.length + 1}`,
      };
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: result.externalId, url: result.url, data: {} };
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
  return { adapter, creates, updates };
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
    pipelineInputId: 'pi-movement-extraction',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}


/** A movement-engine LlmClient that records calls and answers from a
 *  queue of hand-written nested responses. */
function queuedMovementLlm(responses: unknown[]): {
  calls: LlmCallInput[];
  client: { call(input: LlmCallInput): Promise<LlmCallResult> };
} {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    client: {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        if (calls.length > responses.length) {
          throw new Error(`test: unexpected extraction call #${calls.length}:\n${input.system}`);
        }
        return { parsedJson: responses[calls.length - 1] };
      },
    },
  };
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

// ── The movements under test ────────────────────────────────────────────────

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', stage: 'text', thesis: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', thesis: 'text' },
      resultShape: { externalId: 'text', name: 'text', stage: 'text', thesis: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
  },
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
  },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'type Thesis = <"Consumer" | "Infra">',
  'rules = "route infra to Infra"',
].join('\n');

const ENTRY = [
  'node Entry: "each company pitched in this message" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text> "the funding stage"',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '  node founder: "each founder named" { first: <text> "given names" }',
  '}',
].join('\n');

/** The same tree, spelled out inline — what `node entry: <Entry>` stands for. */
const INLINE_ENTRY = [
  '    node entry: "each company pitched in this message" {',
  '      name: <text> "the company\'s name"',
  '      stage: <text> "the funding stage"',
  '      thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '      node founder: "each founder named" { first: <text> "given names" }',
  '    }',
];

function movement(declarations: string, tree: string[], after: string[] = []): string {
  return [
    PRELUDE,
    declarations,
    'movement m(msg: <inbox-[:message]->>) {',
    '  found = extract from [msg.`text`] {',
    ...tree,
    '  }',
    ...after,
    '}',
  ].join('\n');
}

const REPLY = {
  'x:extract_result#1': [
    {
      entry: [
        {
          name: wrap('Acme'),
          stage: wrap('Seed'),
          thesis: wrap('Infra'),
          founder: [{ first: wrap('Ada') }],
        },
      ],
    },
  ],
};

async function run(source: string, attio = makeFakeAdapter('attio')) {
  const llm = queuedMovementLlm([REPLY]);
  const writes: CapturedWrite[] = [];
  await runMovement({
    source,
    event: webhookEvent('email', { subject: 'Deals', text: 'Acme (Ada) is raising a Seed.' }),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: makeResolver({ email: makeFakeAdapter('email').adapter, attio: attio.adapter }),
    llm: llm.client,
    dryRun: true,
    writeSink: (w) => writes.push(w),
  });
  return { calls: llm.calls, writes };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('an extraction node that takes a declaration as its shape', () => {
  it('assembles the SAME prompt as the inline block the declaration spells out', async () => {
    const declared = await run(movement(ENTRY, ['    node entry: <Entry>']));
    const inline = await run(movement('', INLINE_ENTRY));
    expect(declared.calls).toHaveLength(1);
    expect(declared.calls[0].system).toEqual(inline.calls[0].system);
    expect(declared.calls[0].userMessage).toEqual(inline.calls[0].userMessage);
    // The declaration's words reached the model — interpolation included — and
    // its refinement constrained the field.
    expect(declared.calls[0].system).toContain('each company pitched in this message');
    expect(declared.calls[0].system).toContain('the thesis it routes to. route infra to Infra');
    expect(declared.calls[0].system).toContain('`thesis` (enum: Consumer | Infra)');
    expect(declared.calls[0].system).toContain('each founder named');
  });

  it('a use-site description replaces the declaration\'s record-level one', async () => {
    const declared = await run(movement(ENTRY, ['    node entry: <Entry> "each deal, one per company"']));
    expect(declared.calls[0].system).toContain('each deal, one per company');
    expect(declared.calls[0].system).not.toContain('each company pitched in this message');
    // Its fields' words are untouched.
    expect(declared.calls[0].system).toContain("the company's name");
  });

  it('extracts an undescribed field by its name alone', async () => {
    const bare = ['node Entry: "each company" {', '  name: <text>', '}'].join('\n');
    const { calls } = await run(movement(bare, ['    node entry: <Entry>']));
    expect(calls[0].system).toMatch(/^ {4}- `name` \(text\)$/m);
  });

  it('walks records of the declared structure, nested nodes included', async () => {
    const { writes } = await run(
      movement(ENTRY, ['    node entry: <Entry>'], [
        '  found-[e:entry]-> {',
        '    e-[f:founder]-> {',
        '      write crm-[:companies]-> { name: COALESCE(f.first, "?"), stage ?: e.stage }',
        '    }',
        '  }',
      ]),
    );
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'create', fields: { name: 'Ada', stage: 'Seed' } }),
    ]);
  });
});

describe('a spread in a write body', () => {
  const spreading = (body: string) =>
    movement(ENTRY, ['    node entry: <Entry>'], [
      '  found-[e:entry]-> {',
      `    write crm-[:companies]-> { ${body} }`,
      '  }',
    ]);

  it('`?...e` writes every FIELD of the record — never its nested nodes', async () => {
    const { writes } = await run(spreading('unique by (name), ?...e'));
    expect(writes).toEqual([
      expect.objectContaining({
        kind: 'create',
        fields: { name: 'Acme', stage: 'Seed', thesis: 'Infra' },
      }),
    ]);
  });

  it('an explicit line wins over the spread for its field', async () => {
    const { writes } = await run(spreading('stage: "Series A", ?...e'));
    expect(writes).toEqual([
      expect.objectContaining({ fields: { stage: 'Series A', name: 'Acme', thesis: 'Infra' } }),
    ]);
  });

  it('`?...e` is set-if-empty: a matched record keeps the values it has', async () => {
    const attio = makeFakeAdapter('attio', {
      resolveCandidates: () => [{ adapterType: 'attio', externalId: 'existing-1', data: {} }],
    });
    attio.adapter.readRecord = async () => ({ name: 'Acme', stage: 'Series B', thesis: null });
    const { writes } = await run(spreading('unique by (name), ?...e'), attio);
    // `stage` is already set, so the fill leaves it; `thesis` is empty and fills.
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'update', externalId: 'existing-1', fields: { thesis: 'Infra' } }),
    ]);
  });
});

describe('an IMPORTED declaration', () => {
  it("reads its words in its library's scope, not the importer's", async () => {
    const library = [
      'lens = "route by the library\'s lens"',
      'export node Entry: "each company pitched" {',
      '  name: <text> "the name, ${lens}"',
      '}',
    ].join('\n');
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      // The importer binds the same name — the library's must still win.
      'lens = "the importer\'s lens"',
      'movement m(msg: <inbox-[:message]->>) {',
      '  found = extract from [msg.`text`] {',
      '    node entry: <Entry>',
      '  }',
      '}',
    ].join('\n');
    const llm = queuedMovementLlm([{ 'x:extract_result#1': [{ entry: [] }] }]);
    await runMovement({
      source,
      event: webhookEvent('email', { subject: 'Deals', text: 'Acme is raising.' }),
      teamId: TEAM_ID,
      catalog,
      resolveFile: (path) => (path === 'lib/entries' ? { source: library } : undefined),
      resolveAdapter: makeResolver({
        email: makeFakeAdapter('email').adapter,
        attio: makeFakeAdapter('attio').adapter,
      }),
      llm: llm.client,
      dryRun: true,
    });
    expect(llm.calls[0].system).toContain("the name, route by the library's lens");
    expect(llm.calls[0].system).not.toContain("the importer's lens");
  });
});

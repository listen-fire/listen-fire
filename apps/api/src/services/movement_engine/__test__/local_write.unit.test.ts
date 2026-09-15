// Engine coverage for a WRITE into a run-local node's edge — in-process
// deduplication, reusing the write's own vocabulary.
//
// The point of the design is that NOTHING about a write changes when its
// destination is the run's own graph: the same `unique by` lowering, the same
// candidate arbitration and the same single judge, the same `?:` fill against
// what is already there, the same create / update / noop outcomes. So what is
// worth pinning is exactly that — that an edge with a landing on it merges
// rather than accumulating, that a FUZZY block reaches the judge only when
// there is something to judge, and that the row the firing log gets says it
// touched no system.
//
// Mirrors the harness of node_synthesis.unit.test.ts.

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

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

// The ONE judge — mocked at the LLM seam, so the real arbitration (the
// short-circuits, the exactness rule) still runs and only the decision is
// injected.
jest.mock('../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
  parseJsonReply: jest.fn(),
  flattenMessages: jest.fn(),
}));

import { execute } from '../../../lib/prompts/execute';
import { runMovement } from '../run';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { containerAssociation, type Adapter, type RuntimeCapabilities } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;
const mockExecute = execute as jest.MockedFunction<typeof execute>;

/** The judge's reply shape ({match_index, confidence, reasoning}). */
const judged = (match_index: number | null, confidence = 0.9) =>
  ({ match_index, confidence, reasoning: 'test' }) as never;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(adapterType: string): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
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
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return {
        adapterType,
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const catalog = staticCatalogFromManifests({
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  acme_main: 'cred-attio-1',
};

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = email()',
  '',
  'node Company {',
  '  name: <text>',
  '  summary: <text>',
  '}',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-local-write', adapterType: 'email', triggerType: 'webhook', payload };
}

/** The movement body, wrapped — every case declares the same deduping node. */
function run(body: string[], adapters: { email: Adapter; attio: Adapter }) {
  const source =
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      '  deduped = node { companies: <Company> }',
      ...body,
      '}',
    ].join('\n');
  return runMovement({
    source,
    movementName: 'intake',
    event: webhookEvent({}),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'email') return adapters.email;
      if (adapterType === 'attio') return adapters.attio;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
  });
}

/** `deduped`'s landings, read back through an ordinary traversal into a real
 *  write — the only honest way to see what is on the edge. */
const READ_BACK = [
  '  deduped-[c:companies]-> {',
  '    write crm-[:companies]-> { name: c.`name`, summary: c.`summary` }',
  '  }',
];

beforeEach(() => {
  mockExecute.mockReset();
});

describe('two writes of the same thing are one landing', () => {
  it('matches by an exact component, and `?:` fills only what is absent', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '    summary ?: "filled"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '    summary ?: "ignored"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );

    // ONE landing: the second write filled what was absent, the third found it
    // already there and wrote nothing.
    expect(attio.creates.map((w) => w.fields)).toEqual([{ name: 'Acme', summary: 'filled' }]);
    expect(mockExecute).not.toHaveBeenCalled();

    const local = result.writes.filter((w) => w.local !== undefined);
    expect(local.map((w) => w.outcome)).toEqual(['create', 'update', 'noop']);
    expect(local.map((w) => w.writtenValues)).toEqual([
      { name: 'Acme' },
      { summary: 'filled' },
      {},
    ]);
  });

  it('a second identical write sends nothing at all', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(result.writes.map((w) => w.outcome)).toEqual(['create', 'noop']);
  });
});

describe('a FUZZY component blocks on the distinctive word', () => {
  it('two names sharing only the kind word never reach the judge', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Actions AI"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual(['Faction AI', 'Actions AI']);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('the judge picks one of the blocked landings, and the write merges into it', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction Labs"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Faction"',
        '    summary: "the merged one"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    // Two landings, and the merged one kept its place and took the new name.
    // (The untouched landing reads its absent field as null, as any synthesised
    // node's does — nothing about that is this write's doing.)
    expect(attio.creates.map((w) => w.fields)).toEqual([
      { name: 'Faction', summary: 'the merged one' },
      { name: 'Faction Labs', summary: null },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('a declined judgement is a second landing, not a merge', async () => {
    mockExecute.mockResolvedValue(judged(null));
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction AI"',
        '  }',
        '  write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Faction Labs"',
        '  }',
        '  write deduped-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Faction"',
        '  }',
        ...READ_BACK,
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields.name)).toEqual([
      'Faction AI',
      'Faction Labs',
      'Faction',
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

describe('the row the firing log gets', () => {
  it('says it touched no system — local, uncommitted, no external id', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const result = await run(
      [
        '  c = write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(result.writes).toHaveLength(1);
    const row = result.writes[0];
    expect(row.adapterType).toBe('local');
    expect(row.recordType).toBe('companies');
    expect(row.local).toEqual({ edge: 'companies' });
    expect(row.committed).toBe(false);
    expect(row.externalId).toBeUndefined();
    expect(row.bindingName).toBe('c');
  });

  it('a handle the write bound reads its own fields, and links onto another edge', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    await run(
      [
        '  also = node { companies: <Company> }',
        '  c = write deduped-[:companies]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  link also -[:companies]-> c',
        '  also-[x:companies]-> {',
        '    write crm-[:companies]-> { name: x.`name` }',
        '  }',
      ],
      { email: email.adapter, attio: attio.adapter },
    );
    expect(attio.creates.map((w) => w.fields)).toEqual([{ name: 'Acme' }]);
  });
});
